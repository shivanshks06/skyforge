import path from "node:path";
import axios from "axios";

/**
 * Security scanner: static checks over the source (debug mode, hard-coded secrets, insecure
 * configuration), a safe self-pentest of the project's own live URL (GET/HEAD only, ~25 requests),
 * and container image CVE counts, combined into a 0-100 score and A-F grade.
 */

const WEIGHT = { critical: 30, high: 15, medium: 7, low: 2, info: 0 };
const SKIP = /(^|\/)(tests?|__tests__|spec|e2e|docs?|examples?|fixtures|node_modules|vendor|dist|build)\/|\.(test|spec)\.[a-z]+$/i;
const PLACEHOLDER = /^(change.?me|your[_-]|xxx|example|dummy|test|sample|placeholder|<|\$\{|%\(|todo|secret|password|null|none)/i;

const lineOf = (content, index) => content.slice(0, index).split("\n").length;
const finding = (props) => ({ severity: "medium", fixable: false, ...props, id: `${props.source}:${props.rule}:${props.location || props.path || ""}` });

// Patterns whose literal value is itself the leak (provider-specific formats).
const KEY_PATTERNS = [
  { rule: "aws-access-key", regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, title: "AWS access key committed to the repository", severity: "critical" },
  { rule: "stripe-live-key", regex: /\b(sk|rk)_live_[0-9a-zA-Z]{20,}\b/g, title: "Stripe live secret key committed", severity: "critical" },
  { rule: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, title: "GitHub token committed", severity: "critical" },
  { rule: "slack-token", regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, title: "Slack token committed", severity: "critical" },
  { rule: "private-key", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/g, title: "Private key committed", severity: "critical" },
  { rule: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, title: "Google API key committed", severity: "high" },
];

/** files: [{ path, content }] from the repository. */
export function scanCodeSecurity(files) {
  const findings = [];
  const add = (props) => findings.push(finding({ source: "code", ...props }));
  const paths = new Set(files.map((file) => file.path));

  for (const name of [".env", ".env.production", ".env.local", ".env.prod"]) {
    if (paths.has(name)) add({ rule: "committed-env-file", severity: "high", path: name, location: name, title: `${name} is committed to the repository`, detail: "Environment files usually hold real secrets; anyone with access to the repository (or its history) can read them. SkyForge strips it from the image, but it stays in git.", fix: `Remove ${name} from git (git rm --cached ${name}), add it to .gitignore, rotate any secrets it contained, and set the values on SkyForge's Environment page.` });
  }

  for (const { path: file, content } of files) {
    if (!content || SKIP.test(file) || content.length > 512 * 1024) continue;
    const ext = path.extname(file).toLowerCase();
    const base = path.posix.basename(file);

    for (const pattern of KEY_PATTERNS) {
      for (const match of content.matchAll(pattern.regex)) {
        add({ rule: pattern.rule, severity: pattern.severity, path: file, location: `${file}:${lineOf(content, match.index)}`, title: pattern.title, detail: "Credentials in source code are exposed to everyone who can read the repository and stay in git history even after removal.", fix: "Revoke and rotate this credential now, move it to an environment variable set on SkyForge's Environment page, and read it with process.env / os.environ.", fixable: true });
        break;
      }
    }

    if (ext === ".py") {
      const debug = content.match(/^DEBUG\s*=\s*True\b/m);
      if (debug && /settings/.test(file)) {
        add({ rule: "django-debug", severity: "high", path: file, location: `${file}:${lineOf(content, debug.index)}`, title: "Django runs with DEBUG = True", detail: "Error pages show source code, settings, and environment details to every visitor.", fix: 'Read it from the environment: DEBUG = os.environ.get("DJANGO_DEBUG", "False").lower() == "true"', fixable: true });
      }
      const secret = content.match(/^SECRET_KEY\s*=\s*(['"])([^'"]{8,})\1/m);
      if (secret && !PLACEHOLDER.test(secret[2])) {
        add({ rule: "django-secret-key", severity: "high", path: file, location: `${file}:${lineOf(content, secret.index)}`, title: "Django SECRET_KEY is hard-coded", detail: "Anyone with the repository can forge sessions, password-reset tokens, and signed cookies.", fix: 'Use SECRET_KEY = os.environ["DJANGO_SECRET_KEY"] and set a new random value on the Environment page.', fixable: true });
      }
      const hosts = content.match(/^ALLOWED_HOSTS\s*=\s*\[\s*['"]\*['"]\s*\]/m);
      if (hosts) add({ rule: "django-allowed-hosts", severity: "low", path: file, location: `${file}:${lineOf(content, hosts.index)}`, title: "ALLOWED_HOSTS accepts any host", detail: "Enables Host-header attacks such as password-reset link poisoning.", fix: "List the real domain(s), e.g. read them from DJANGO_ALLOWED_HOSTS." });
      const flaskDebug = content.match(/\.run\([^)]*debug\s*=\s*True/);
      if (flaskDebug) add({ rule: "flask-debug", severity: "medium", path: file, location: `${file}:${lineOf(content, flaskDebug.index)}`, title: "Flask debug mode is enabled in app.run()", detail: "If this entry point runs, the Werkzeug debugger allows remote code execution.", fix: 'Use debug=os.environ.get("FLASK_DEBUG") == "1".', fixable: true });
    }

    if (/\.(js|ts|mjs|cjs)$/.test(ext)) {
      const cors = content.match(/origin\s*:\s*['"]\*['"][\s\S]{0,120}credentials\s*:\s*true|credentials\s*:\s*true[\s\S]{0,120}origin\s*:\s*['"]\*['"]/);
      if (cors) add({ rule: "cors-wildcard-credentials", severity: "medium", path: file, location: `${file}:${lineOf(content, cors.index)}`, title: "CORS allows any origin together with credentials", detail: "Lets other websites make authenticated requests on behalf of your users.", fix: "Restrict origin to your own domain(s)." });
    }

    if (/(^|\/)application[\w-]*\.(properties|ya?ml)$/.test(file)) {
      const actuator = content.match(/exposure\.include\s*[=:]\s*["']?\*/);
      if (actuator) add({ rule: "spring-actuator-exposed", severity: "high", path: file, location: `${file}:${lineOf(content, actuator.index)}`, title: "All Spring Boot actuator endpoints are exposed", detail: "Endpoints such as /actuator/env and /actuator/heapdump can leak secrets.", fix: "Expose only health,info: management.endpoints.web.exposure.include=health,info" });
    }

    // Generic hard-coded credentials, limited to configuration modules to keep false positives low.
    if (/\.(py|js|ts|rb|php|go|java|cs)$/.test(ext) && /settings|config|secrets?|credentials|constants/i.test(base)) {
      for (const match of content.matchAll(/\b([A-Za-z_]*(?:PASSWORD|PASSWD|SECRET|API_?KEY|TOKEN)[A-Za-z_]*)\s*[:=]\s*(['"])([^'"\s]{12,})\2/gi)) {
        if (PLACEHOLDER.test(match[3]) || /environ|getenv|process\.env|ENV\[/.test(match[0])) continue;
        add({ rule: "hardcoded-credential", severity: "medium", path: file, location: `${file}:${lineOf(content, match.index)}`, title: `Possible hard-coded credential (${match[1]})`, detail: "Secrets in source are readable by anyone with repository access.", fix: "Move the value to an environment variable.", fixable: true });
      }
    }
  }

  const pkg = files.find((file) => file.path === "package.json");
  if (pkg && /"express"/.test(pkg.content) && !/"helmet"/.test(pkg.content)) {
    add({ rule: "express-no-helmet", severity: "low", path: "package.json", location: "package.json", title: "Express app without security headers (helmet)", detail: "Missing headers such as X-Frame-Options and X-Content-Type-Options.", fix: "npm install helmet, then app.use(require('helmet')())" });
  }
  // The generic credential rule yields to a specific rule on the same line.
  const specific = new Set(findings.filter((item) => item.rule !== "hardcoded-credential").map((item) => item.location));
  return dedupe(findings.filter((item) => item.rule !== "hardcoded-credential" || !specific.has(item.location)));
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((item) => (seen.has(item.id) ? false : seen.add(item.id)));
}

/**
 * Safe self-pentest of the project's own deployment. `scanToken` is sent as x-skyforge-scan so the
 * project's WAF lets the scanner through (the report describes the application itself).
 */
export async function runSelfPentest(liveUrl, { scanToken, timeoutMs = 8000 } = {}) {
  const base = new URL(liveUrl);
  const findings = [];
  const add = (props) => findings.push(finding({ source: "pentest", ...props }));
  const get = async (pathname, extraHeaders = {}) => {
    try {
      const response = await axios.get(new URL(pathname, base).toString(), {
        timeout: timeoutMs,
        maxRedirects: 0,
        responseType: "text",
        transformResponse: (data) => data,
        maxContentLength: 512 * 1024,
        validateStatus: () => true,
        headers: { "User-Agent": "SkyForge-SecurityScan/1.0", ...(scanToken ? { "x-skyforge-scan": scanToken } : {}), ...extraHeaders },
      });
      return { status: response.status, headers: response.headers, body: typeof response.data === "string" ? response.data : "" };
    } catch {
      return null;
    }
  };

  const home = await get("/");
  if (!home) {
    return { findings: [finding({ source: "pentest", rule: "unreachable", severity: "info", title: "The site could not be reached for scanning", detail: "The self-pentest was skipped.", fix: "Make sure the deployment is live." })], scannedUrl: base.toString() };
  }

  if (base.protocol === "http:") add({ rule: "no-https", severity: "medium", location: base.host, title: "Traffic is not encrypted (HTTP only)", detail: "Passwords, cookies, and form data cross the network in plain text.", fix: "Add HTTPS: a custom domain with an ACM certificate, or CloudFront once the AWS account is verified." });

  const exposures = [
    { path: "/.git/HEAD", test: (r) => r.status === 200 && /^ref:\s|^[0-9a-f]{40}\s*$/m.test(r.body), rule: "exposed-git", severity: "critical", title: "Git repository exposed at /.git/", detail: "Attackers can download the full source code and history, including removed secrets." },
    { path: "/.env", test: (r) => r.status === 200 && /^[A-Z_][A-Z0-9_]*=.+/m.test(r.body) && !/<html/i.test(r.body), rule: "exposed-env", severity: "critical", title: "Environment file exposed at /.env", detail: "Secrets such as database passwords and API keys can be downloaded." },
    { path: "/db.sqlite3", test: (r) => r.status === 200 && r.body.startsWith("SQLite format 3"), rule: "exposed-database", severity: "critical", title: "Database file downloadable at /db.sqlite3", detail: "The entire database can be downloaded." },
    { path: "/.DS_Store", test: (r) => r.status === 200 && r.body.includes("Bud1"), rule: "exposed-ds-store", severity: "low", title: ".DS_Store file exposed", detail: "Reveals file and folder names on the server." },
    { path: "/server-status", test: (r) => r.status === 200 && /Apache Server Status/i.test(r.body), rule: "exposed-server-status", severity: "medium", title: "Apache server-status is public", detail: "Shows live requests, client IPs, and URLs." },
    { path: "/actuator/env", test: (r) => r.status === 200 && /propertySources|activeProfiles/.test(r.body), rule: "exposed-actuator", severity: "high", title: "Spring actuator /env is public", detail: "Leaks configuration and possibly secrets." },
  ];
  for (const check of exposures) {
    const response = await get(check.path);
    if (response && check.test(response)) add({ rule: check.rule, severity: check.severity, location: check.path, title: check.title, detail: check.detail, fix: "Block the path and make sure the file is not deployed (check .dockerignore and static file settings)." });
  }

  const missing = await get(`/skyforge-scan-${Date.now().toString(36)}-not-found`);
  if (missing) {
    const body = missing.body;
    const leak = [
      [/Using the URLconf defined in|Django tried these URL patterns/i, "Django debug 404 page"],
      [/Traceback \(most recent call last\)|Werkzeug Debugger/i, "Python traceback / Werkzeug debugger"],
      [/Whoops! There was an error|Ignition/i, "Laravel debug page"],
      [/at Layer\.handle|at Function\.handle|node_modules\//i, "Node.js stack trace"],
      [/Whitelabel Error Page[\s\S]*trace/i, "Spring stack trace"],
      [/Exception in thread|java\.lang\./, "Java exception details"],
    ].find(([regex]) => regex.test(body));
    if (leak) add({ rule: "debug-error-page", severity: "high", location: missing.status ? `HTTP ${missing.status} page` : "error page", title: `Debug error pages are public (${leak[1]})`, detail: "Error pages reveal source code paths, settings, and internal routes to anyone.", fix: "Turn off debug mode in production (DEBUG=False, APP_DEBUG=false, NODE_ENV=production).", fixable: false });
  }

  const admin = await get("/admin/");
  const adminBody = admin?.status === 302 || admin?.status === 301 ? (await get(admin.headers.location || "/admin/login/"))?.body || "" : admin?.body || "";
  if (/Django administration|Log in \| Django site admin/i.test(adminBody)) add({ rule: "public-admin", severity: "low", location: "/admin/", title: "Django admin login is publicly reachable", detail: "A common brute-force target.", fix: "Use the Protected tier (login rate limiting), a non-default admin URL, and strong passwords or 2FA." });

  const listing = /<title>Index of \//i.test(home.body) ? home : await get("/static/");
  if (listing && /<title>Index of \//i.test(listing.body)) add({ rule: "directory-listing", severity: "medium", location: "/static/", title: "Directory listing is enabled", detail: "Visitors can browse every file in the directory.", fix: "Disable autoindex in the web server configuration." });

  const headers = home.headers || {};
  const missingHeaders = [
    ["x-content-type-options", "X-Content-Type-Options"],
    ["x-frame-options", "X-Frame-Options (or CSP frame-ancestors)"],
    ["referrer-policy", "Referrer-Policy"],
  ].filter(([name]) => !headers[name] && !(name === "x-frame-options" && /frame-ancestors/i.test(headers["content-security-policy"] || "")));
  if (missingHeaders.length) add({ rule: "missing-security-headers", severity: "low", location: "/", title: `Missing security headers: ${missingHeaders.map(([, label]) => label).join(", ")}`, detail: "Without them browsers allow clickjacking and MIME-type sniffing.", fix: "Static sites deployed by SkyForge get them automatically. For app servers: Django SecurityMiddleware + X_FRAME_OPTIONS, Express helmet(), Flask-Talisman." });

  // Only real version numbers count ("nginx/1.25.3", not "AmazonS3").
  const banner = [headers["x-powered-by"], /\d+\.\d+/.test(headers.server || "") ? headers.server : null].filter(Boolean);
  if (banner.length) add({ rule: "version-banner", severity: "low", location: "/", title: `Server software and version disclosed (${banner.join(", ").slice(0, 80)})`, detail: "Helps attackers pick exploits for the exact version.", fix: "Remove the X-Powered-By / Server version headers (e.g. app.disable('x-powered-by'))." });

  for (const cookie of [].concat(headers["set-cookie"] || [])) {
    if (/session|sid|token|auth/i.test(cookie.split("=")[0]) && (!/httponly/i.test(cookie) || !/samesite/i.test(cookie))) {
      add({ rule: "insecure-cookie", severity: "low", location: cookie.split("=")[0], title: `Session cookie ${cookie.split("=")[0]} lacks HttpOnly/SameSite`, detail: "Scripts or other sites can read or send the session cookie.", fix: "Set HttpOnly and SameSite=Lax on session cookies." });
      break;
    }
  }

  const corsProbe = await get("/", { Origin: "https://attacker.example" });
  if (corsProbe && corsProbe.headers["access-control-allow-origin"] === "https://attacker.example" && String(corsProbe.headers["access-control-allow-credentials"]) === "true") {
    add({ rule: "cors-reflection", severity: "high", location: "/", title: "CORS reflects any origin with credentials", detail: "Any website can read authenticated responses of your users.", fix: "Only allow your own origins." });
  }

  const marker = `skyforge${Date.now().toString(36)}`;
  const xss = await get(`/?q=%3C${marker}%3E&search=%3C${marker}%3E`);
  if (xss && xss.status < 400 && xss.body.includes(`<${marker}>`)) add({ rule: "reflected-input", severity: "high", location: "/?q=", title: "User input is reflected without escaping", detail: "Indicates a likely reflected cross-site scripting (XSS) vulnerability.", fix: "Escape output in templates; never insert raw query parameters into HTML." });

  for (const param of ["next", "redirect", "url", "return", "returnTo"]) {
    const redirect = await get(`/?${param}=https://attacker.example/`);
    if (redirect && [301, 302, 303, 307, 308].includes(redirect.status) && /^https?:\/\/attacker\.example/.test(redirect.headers.location || "")) {
      add({ rule: "open-redirect", severity: "medium", location: `/?${param}=`, title: `Open redirect via ?${param}=`, detail: "Attackers can use your domain to redirect victims to phishing sites.", fix: "Only redirect to relative paths or an allow-list of hosts." });
      break;
    }
  }
  return { findings: dedupe(findings), scannedUrl: base.toString() };
}

export function imageFindings(scan) {
  if (!scan || scan.status !== "COMPLETE") return [];
  const counts = scan.counts || {};
  const items = [];
  if (counts.CRITICAL) items.push(finding({ source: "image", rule: "image-critical-cves", severity: "high", location: scan.imageDigest?.slice(0, 19), title: `${counts.CRITICAL} critical vulnerabilities in the container image`, detail: (scan.top || []).filter((cve) => cve.severity === "CRITICAL").slice(0, 3).map((cve) => `${cve.name} (${cve.package})`).join(", "), fix: "Update the base image and dependencies, then redeploy." }));
  if (counts.HIGH) items.push(finding({ source: "image", rule: "image-high-cves", severity: "medium", location: scan.imageDigest?.slice(0, 19), title: `${counts.HIGH} high-severity vulnerabilities in the container image`, detail: (scan.top || []).filter((cve) => cve.severity === "HIGH").slice(0, 3).map((cve) => `${cve.name} (${cve.package})`).join(", "), fix: "Update the base image and dependencies, then redeploy." }));
  return items;
}

export function scoreFindings(findings) {
  const score = Math.max(0, 100 - findings.reduce((total, item) => total + (WEIGHT[item.severity] ?? 0), 0));
  const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return { score, grade, findings: [...findings].sort((a, b) => order[a.severity] - order[b.severity]) };
}

const ROUTE_PATTERNS = [
  /\.(?:get|post|put|patch|delete|all|use|route)\(\s*['"`](\/[^'"`\s]*)['"`]/g, // Express, Koa, Fastify, Hono
  /\b(?:re_)?path\(\s*r?['"]\^?([^'"]*)['"]/g, // Django
  /@\w+\.(?:route|get|post|put|patch|delete|api_route)\(\s*['"]([^'"]+)['"]/g, // Flask, FastAPI
  /@(?:Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?\{?\s*"([^"]+)"/g, // Spring
  /^\s*(?:get|post|put|patch|delete|match|resources?)\s+['"]([^'"]+)['"]/gm, // Rails
  /Route::(?:get|post|put|patch|delete|any|match)\(\s*['"]([^'"]+)['"]/g, // Laravel
];
export const LOGIN_ROUTE = /log-?in|sign-?in|sign-?up|auth|token|session|password|register|otp|2fa/i;

/** Routes declared in the source, normalised to "/path" form. */
export function extractRoutes(files) {
  const routes = new Set();
  for (const { path: file, content } of files) {
    // Next.js / Nuxt / SvelteKit file-based routes come from the file path itself.
    const fileRoute = file.match(/^(?:src\/)?(?:app|pages|routes)\/(.+?)\/(?:page|route|\+page|\+server)?\.?(?:[jt]sx?|vue|svelte)$/)
      || file.match(/^(?:src\/)?pages\/(.+?)\.(?:[jt]sx?|vue)$/);
    if (fileRoute) routes.add(`/${fileRoute[1].replace(/\/index$/, "").replace(/\[[^\]]+\]/g, "*")}`);
    if (!content || !/\.(js|jsx|ts|tsx|mjs|cjs|py|rb|php|java|kt)$/.test(file)) continue;
    for (const pattern of ROUTE_PATTERNS) {
      for (const match of content.matchAll(pattern)) {
        const route = `/${String(match[1] || "").replace(/^\/+|\$$/g, "")}`.replace(/<[^>]+>|:\w+|\{[^}]+\}/g, "*");
        if (route.length > 1 && route.length < 120) routes.add(route);
      }
    }
  }
  return [...routes];
}

