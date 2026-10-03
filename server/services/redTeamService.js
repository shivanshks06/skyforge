import axios from "axios";
import { GoogleGenAI } from "@google/genai";
import { AI_MODEL } from "./aiPlanner.js";
import { LOGIN_ROUTE } from "./securityScanner.js";

/**
 * Safe offensive checks against the project's OWN live site, run only when its owner asks:
 *
 *  - Attack replay: re-sends the paths of requests the firewall blocked, with SkyForge's scanner
 *    header so the firewall lets them through, to learn whether the app itself would have been
 *    vulnerable without the firewall.
 *  - AI red-team rehearsal: an AI (or a built-in planner) picks the riskiest routes from the source
 *    and runs a fixed catalogue of read-only probes against them.
 *
 * Every request is GET, HEAD or OPTIONS, sequential, time-limited and capped, never sends bodies,
 * and only targets the deployment's own URL.
 */

const MAX_REQUESTS = 80;
// Some apps change data on GET (e.g. /items/1/delete). Never request such routes, whoever planned them.
export const STATE_CHANGING = /(^|[/_.-])(delete|remove|destroy|drop|purge|update|edit|add|create|new|insert|save|submit|logout|log-out|signout|sign-out|reset|cancel|unsubscribe|approve|reject|transfer|pay|checkout|order|send|invite|activate|deactivate|toggle|complete|archive|restore|import|upload|sync|refresh|run|exec|execute|trigger|install|uninstall)([/_.?-]|$)/i;
const PAUSE_MS = 120;
const SUSPICIOUS = [
  [/root:x:0:0:|\[boot loader\]|\[extensions\]/i, "system file contents", "critical"],
  [/aws_secret_access_key|AWS_SECRET_ACCESS_KEY\s*=|-----BEGIN [A-Z ]*PRIVATE KEY-----/, "credentials", "critical"],
  [/^[A-Z][A-Z0-9_]{2,}=.+$/m, "environment variables", "high"],
  [/Traceback \(most recent call last\)|at [\w$.<>]+ \([^)]*\.(js|ts):\d+:\d+\)|Whoops! There was an error|Exception in thread|java\.lang\.\w+Exception/, "a stack trace", "medium"],
  [/You have an error in your SQL syntax|SQLSTATE\[|PG::SyntaxError|sqlite3\.OperationalError|ORA-\d{5}|unterminated quoted string/i, "a database error (possible SQL injection)", "high"],
  [/<title>phpinfo\(\)<\/title>|PHP Version \d/i, "phpinfo output", "high"],
  [/<title>Index of \//i, "a directory listing", "medium"],
];

function client(liveUrl, scanToken) {
  const base = new URL(liveUrl);
  let sent = 0;
  const request = async (method, target, headers = {}) => {
    if (sent >= MAX_REQUESTS) return null;
    if (STATE_CHANGING.test(String(target).split("?")[0])) return null;
    sent += 1;
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    const url = new URL(target, base);
    if (url.host !== base.host) return null;
    try {
      const response = await axios.request({
        method, url: url.toString(), timeout: 10_000, maxRedirects: 0, responseType: "text", transformResponse: (data) => data,
        maxContentLength: 512 * 1024, validateStatus: () => true,
        headers: { "User-Agent": "SkyForge-RedTeam/1.0 (owner-initiated)", ...(scanToken ? { "x-skyforge-scan": scanToken } : {}), ...headers },
      });
      return { status: response.status, headers: response.headers, body: typeof response.data === "string" ? response.data : "" };
    } catch {
      return null;
    }
  };
  return { request, get: (target, headers) => request("GET", target, headers), sentCount: () => sent };
}

function classify(response) {
  if (!response || response.status >= 400) return null;
  for (const [pattern, label, severity] of SUSPICIOUS) if (pattern.test(response.body)) return { label, severity };
  return null;
}

/**
 * Replays the paths of recently blocked requests against the app with the firewall bypassed.
 * `blocked` is the dashboard's recent list: [{ path, method, rule, ip }].
 */
export async function replayBlockedAttacks({ liveUrl, scanToken, blocked = [], decoyMarkers = [] }) {
  const http = client(liveUrl, scanToken);
  const unique = [...new Map(blocked.filter((hit) => hit.path && !STATE_CHANGING.test(hit.path) && ["GET", "HEAD"].includes(String(hit.method || "GET").toUpperCase())).map((hit) => [hit.path, hit])).values()].slice(0, 40);
  const results = [];
  for (const hit of unique) {
    const response = await http.get(hit.path);
    const isDecoy = response && decoyMarkers.some((marker) => marker && response.body.includes(marker));
    const verdict = isDecoy ? null : classify(response);
    results.push({
      path: hit.path,
      rule: hit.rule,
      status: response?.status ?? null,
      outcome: !response ? "unreachable" : verdict ? "vulnerable" : response.status < 400 ? "served (no sensitive content)" : "safe",
      ...(verdict ? { severity: verdict.severity, detail: `Without the firewall the app returned ${verdict.label}.` } : {}),
    });
  }
  return {
    replayed: results.length,
    vulnerable: results.filter((item) => item.outcome === "vulnerable"),
    results,
    note: blocked.length ? null : "No blocked requests were sampled in the last 3 hours, so there was nothing to replay.",
  };
}

// ---------------------------------------------------------------- AI red-team rehearsal (#20)

const CHECKS = {
  "unauthenticated-access": "Request an admin, account or API route without logging in and see whether it returns data instead of a login redirect or 401/403.",
  "idor": "Request numbered records (e.g. /api/users/1 and /2) without authentication and see whether personal data is returned.",
  "open-redirect": "Add ?next=/?redirect=/?url= pointing to another site on login/logout routes and see whether the app redirects there.",
  "reflected-input": "Send a harmless unique marker in query parameters and see whether it comes back unescaped in HTML.",
  "verbose-errors": "Send malformed parameters (a quote, a huge number) and see whether the app shows stack traces or database errors.",
  "cors": "Send Origin: https://redteam.invalid and see whether the API reflects it with credentials allowed.",
  "http-methods": "Send OPTIONS and see whether TRACE or other unexpected methods are enabled.",
  "exposed-docs": "Look for public API documentation, GraphQL introspection or debug consoles.",
};

function heuristicPlan(routes) {
  const clean = [...new Set(routes.map((route) => route.replace(/\*+/g, "1").replace(/\/+$/, "") || "/"))].filter((route) => route.length < 100 && !STATE_CHANGING.test(route));
  const pick = (pattern, limit) => clean.filter((route) => pattern.test(route)).slice(0, limit);
  return [
    ...pick(/admin|dashboard|manage|staff|account|profile|settings|users?|orders?|billing/i, 8).map((route) => ({ check: "unauthenticated-access", route })),
    ...pick(/\/(api\/)?(users?|accounts?|orders?|invoices?|profiles?|customers?|items?|posts?)\/1$/i, 4).map((route) => ({ check: "idor", route })),
    ...pick(LOGIN_ROUTE, 3).map((route) => ({ check: "open-redirect", route })),
    ...pick(/search|query|find|filter|q$/i, 3).map((route) => ({ check: "reflected-input", route })),
    ...pick(/\/1$|id|detail|view|show/i, 3).map((route) => ({ check: "verbose-errors", route })),
    { check: "cors", route: pick(/^\/api/i, 1)[0] || "/" },
    { check: "http-methods", route: "/" },
    { check: "exposed-docs", route: "/" },
  ];
}

async function aiPlan({ routes, framework }) {
  if (!process.env.GEMINI_API_KEY || !routes.length) return null;
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const prompt = `You plan a SAFE, read-only security rehearsal against the owner's own web app.
Framework: ${framework || "unknown"}
Routes found in the source (* = parameter): ${routes.filter((route) => !STATE_CHANGING.test(route)).slice(0, 150).join(", ")}
Never choose routes that could change data (delete, update, add, logout, reset, ...).
Available checks (GET/HEAD/OPTIONS only, no request bodies, nothing that changes data):
${Object.entries(CHECKS).map(([name, text]) => `- ${name}: ${text}`).join("\n")}
Pick at most 20 {check, route} pairs where a real attacker would look first. Replace * with 1.
Return ONLY JSON: {"plan":[{"check":"...","route":"/..."}],"reasoning":"one sentence"}`;
    const response = await ai.models.generateContent({ model: AI_MODEL, contents: prompt, config: { responseMimeType: "application/json", temperature: 0.2 } });
    const parsed = JSON.parse(String(response?.text || "{}").replace(/```json|```/g, ""));
    const plan = (parsed.plan || []).filter((item) => CHECKS[item.check] && typeof item.route === "string" && item.route.startsWith("/") && item.route.length < 120 && !STATE_CHANGING.test(item.route)).slice(0, 20);
    return plan.length ? { plan, reasoning: String(parsed.reasoning || "").slice(0, 300) } : null;
  } catch {
    return null;
  }
}

async function runCheck(http, { check, route }) {
  const marker = `sfrt${Date.now().toString(36)}`;
  const finding = (severity, title, detail, fix) => ({ check, route, severity, title, detail, fix });
  if (check === "unauthenticated-access") {
    const response = await http.get(route, { Accept: "text/html,application/json" });
    if (!response || response.status !== 200) return null;
    const looksLikeLogin = /<input[^>]+type=["']?password|log ?in|sign ?in|csrf/i.test(response.body);
    const looksLikeData = /"(email|password|token|ssn|phone|address|balance)"\s*:|<table/i.test(response.body);
    if (!looksLikeLogin && looksLikeData) return finding("high", `${route} returns data without logging in`, "The route answered HTTP 200 with what looks like records or account data to an anonymous visitor.", "Require authentication on this route (login_required, auth middleware, @PreAuthorize).");
    return null;
  }
  if (check === "idor") {
    const [first, second] = [await http.get(route), await http.get(route.replace(/1$/, "2"))];
    if (first?.status === 200 && second?.status === 200 && first.body !== second.body && /"(email|name|phone|address|user)"\s*:/i.test(first.body)) {
      return finding("high", `Records are readable by number at ${route.replace(/1$/, "{id}")}`, "Consecutive IDs return different personal records without authentication (insecure direct object reference).", "Check that the logged-in user owns the record before returning it.");
    }
    return null;
  }
  if (check === "open-redirect") {
    for (const param of ["next", "redirect", "url", "returnTo", "return_to", "continue"]) {
      const response = await http.get(`${route}${route.includes("?") ? "&" : "?"}${param}=https://redteam.invalid/`);
      if (response && response.status >= 300 && response.status < 400 && /^https?:\/\/redteam\.invalid/.test(response.headers.location || "")) {
        return finding("medium", `Open redirect on ${route}?${param}=`, "Attackers can send phishing links that start with your domain.", "Only redirect to relative paths or an allow-list of hosts.");
      }
    }
    return null;
  }
  if (check === "reflected-input") {
    const response = await http.get(`${route}${route.includes("?") ? "&" : "?"}q=%3C${marker}%3E&search=%3C${marker}%3E&query=%3C${marker}%3E`);
    if (response && response.status < 400 && response.body.includes(`<${marker}>`)) return finding("high", `Unescaped input reflected on ${route}`, "Query input appears in the HTML without escaping (reflected XSS).", "Escape all output in templates.");
    return null;
  }
  if (check === "verbose-errors") {
    for (const variant of [`${route}'`, `${route}?id=1'`, `${route.replace(/1$/, "99999999999999999999")}`]) {
      const response = await http.get(variant);
      const verdict = response && response.status >= 500 ? [...SUSPICIOUS].find(([pattern]) => pattern.test(response.body)) : null;
      if (verdict) return finding(verdict[2] === "high" ? "high" : "medium", `${route} leaks ${verdict[1]} on bad input`, "Malformed input produces internal error details.", "Turn off debug mode and handle invalid input with a generic error.");
    }
    return null;
  }
  if (check === "cors") {
    const response = await http.get(route, { Origin: "https://redteam.invalid" });
    if (response?.headers["access-control-allow-origin"] === "https://redteam.invalid" && String(response.headers["access-control-allow-credentials"]) === "true") {
      return finding("high", `CORS on ${route} trusts any website with credentials`, "Other sites can read logged-in users' data from this API.", "Allow only your own origins.");
    }
    return null;
  }
  if (check === "http-methods") {
    const response = await http.request("OPTIONS", route);
    const allow = String(response?.headers?.allow || response?.headers?.["access-control-allow-methods"] || "");
    if (/TRACE/i.test(allow)) return finding("low", "HTTP TRACE is enabled", "TRACE can help steal cookies in some browser/proxy setups.", "Disable TRACE in the web server.");
    return null;
  }
  if (check === "exposed-docs") {
    for (const target of ["/swagger-ui.html", "/swagger/index.html", "/api-docs", "/docs", "/graphql?query=%7B__schema%7Btypes%7Bname%7D%7D%7D", "/graphiql", "/__debug__/", "/console"]) {
      const response = await http.get(target);
      if (response?.status === 200 && /swagger|openapi|"__schema"|graphiql|Werkzeug|debug toolbar|H2 Console/i.test(response.body)) {
        return finding(/__debug__|console|Werkzeug/i.test(target + response.body) ? "high" : "low", `${target.split("?")[0]} is public`, "API documentation, schema introspection or a debug console is reachable by anyone.", "Disable it in production or put it behind authentication.");
      }
    }
    return null;
  }
  return null;
}

export async function runRedTeam({ liveUrl, scanToken, routes = [], framework = null }) {
  const ai = await aiPlan({ routes, framework });
  const plan = ai?.plan || heuristicPlan(routes);
  const http = client(liveUrl, scanToken);
  const findings = [];
  for (const step of plan) {
    const result = await runCheck(http, step).catch(() => null);
    if (result) findings.push(result);
    if (http.sentCount() >= MAX_REQUESTS) break;
  }
  return {
    planner: ai ? `Gemini ${AI_MODEL}` : "built-in planner",
    reasoning: ai?.reasoning || "Prioritised admin/account routes, numbered records, login redirects, search inputs, and API CORS.",
    plan,
    requests: http.sentCount(),
    findings,
    at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- blast radius (#13)

/**
 * What an attacker who fully controls the container could reach: secrets in its environment,
 * AWS permissions of its task role, network reach, data stores, and the canary that would reveal them.
 */
export function blastRadius({ project, resources, taskRole = null, egressPorts = null, egressLockdown = false }) {
  const env = Object.keys(project.envConfig || {});
  const secretNames = env.filter((name) => /SECRET|PASSWORD|TOKEN|KEY|PRIVATE|DATABASE_URL|DSN|CREDENTIAL/i.test(name));
  const dataStores = env.filter((name) => /DATABASE_URL|DB_|POSTGRES|MYSQL|MONGO|REDIS|ELASTIC|S3_BUCKET|BUCKET/i.test(name));
  const statements = [...(taskRole?.inline || []).flatMap((policy) => [].concat(policy.document?.Statement || []))];
  const actions = statements.flatMap((statement) => [].concat(statement.Action || [])).filter(Boolean);
  const wildcard = actions.some((action) => action === "*" || /:\*$/.test(action)) || (taskRole?.attached || []).some((policy) => /FullAccess|Administrator|PowerUser/i.test(policy.name));
  const nodes = [
    { id: "container", label: "Your container", kind: "origin" },
    ...secretNames.map((name) => ({ id: `secret:${name}`, label: name, kind: "secret" })),
    ...dataStores.filter((name) => !secretNames.includes(name)).map((name) => ({ id: `data:${name}`, label: name, kind: "data" })),
    ...(actions.length || taskRole?.attached?.length ? [{ id: "aws", label: `AWS: ${actions.length ? actions.slice(0, 6).join(", ") : ""}${taskRole?.attached?.length ? ` ${taskRole.attached.map((policy) => policy.name).join(", ")}` : ""}`.trim(), kind: "aws" }] : []),
    { id: "network", label: egressLockdown && egressPorts ? `Internet on TCP ${egressPorts.join(", ")} only` : "Internet on any port", kind: "network" },
    ...(project.protection?.canary ? [{ id: "canary", label: "Canary key (tripwire: any use alerts you)", kind: "canary" }] : []),
  ];
  const score = Math.min(100, secretNames.length * 8 + dataStores.length * 6 + actions.length * 3 + (wildcard ? 40 : 0) + (egressLockdown ? 0 : 15));
  const advice = [
    wildcard ? "The task role has wildcard or full-access permissions; replace them with the permissions generated from your code." : null,
    !egressLockdown ? "Turn on the outbound firewall so a compromised container cannot call out on arbitrary ports." : null,
    secretNames.length > 5 ? "Many secrets share one container; split services or use per-service credentials where possible." : null,
    !project.protection?.canary ? "Redeploy to plant a canary key that reveals environment leaks." : null,
  ].filter(Boolean);
  return {
    level: score >= 60 ? "high" : score >= 30 ? "medium" : "low",
    score,
    secrets: secretNames,
    dataStores,
    awsActions: actions,
    attachedPolicies: (taskRole?.attached || []).map((policy) => policy.name),
    wildcardPermissions: wildcard,
    network: egressLockdown && egressPorts ? { restricted: true, ports: egressPorts } : { restricted: false },
    nodes,
    edges: nodes.filter((node) => node.id !== "container").map((node) => ({ from: "container", to: node.id })),
    advice,
    staticSite: /^S3_/.test(resources?.type || ""),
  };
}
