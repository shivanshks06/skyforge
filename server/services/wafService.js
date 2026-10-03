import {
  WAFV2Client,
  AssociateWebACLCommand,
  CreateIPSetCommand,
  CreateWebACLCommand,
  DeleteIPSetCommand,
  DeleteWebACLCommand,
  DisassociateWebACLCommand,
  GetIPSetCommand,
  GetSampledRequestsCommand,
  GetWebACLCommand,
  GetWebACLForResourceCommand,
  ListIPSetsCommand,
  ListWebACLsCommand,
  UpdateIPSetCommand,
  UpdateWebACLCommand,
} from "@aws-sdk/client-wafv2";

/**
 * AWS WAF ("Protected" tier). One web ACL per project, attached to the load balancer (REGIONAL
 * scope) or, for S3 + CloudFront sites, to the CloudFront distribution (CLOUDFRONT scope, which
 * AWS only serves from us-east-1). Rules, in evaluation order:
 *
 *   skyforge-scanner  allow SkyForge's own scanner (secret header)
 *   admin-door        secret rotating link that unlocks the admin area (sets a cookie)
 *   banned-ips        this project's bans + attacker IPs shared by other SkyForge projects
 *   decoys            fake .env / AWS credential files holding a honey key (deception)
 *   robots            a robots.txt whose Disallow lines are traps (only when the app has none)
 *   tripwire          paths only scanners request; the monitor bans whoever hits them
 *   admin-lockdown    admin routes only from allowed IPs or with the door cookie
 *   bot-challenge     silent JavaScript challenge for HTML page loads (login pages or all)
 *   login-rate-limit  per-IP limit on login routes found in the source (self-tuning)
 *   global-rate-limit per-IP limit on everything (self-tuning)
 *   AWS managed groups: IP reputation, known bad inputs, OWASP core, SQL injection
 *
 * Cost: $5 per web ACL + $1 per rule per month + $0.60 per million requests.
 */

const LIMITS = { normal: { global: 2000, login: 100 }, underAttack: { global: 300, login: 20 } };
const MANAGED_GROUPS = [
  { name: "AWSManagedRulesAmazonIpReputationList", metric: "ip-reputation" },
  { name: "AWSManagedRulesKnownBadInputsRuleSet", metric: "known-bad-inputs" },
  // The core rule set blocks request bodies over 8 KB, which breaks uploads and large forms.
  { name: "AWSManagedRulesCommonRuleSet", metric: "owasp-core", countOnly: ["SizeRestrictions_BODY"] },
  { name: "AWSManagedRulesSQLiRuleSet", metric: "sql-injection" },
];

// Paths scanners probe; never part of the apps SkyForge generates unless the source says so.
const TRIPWIRE_PATHS = [
  "/.env", "/.git/", "/.aws/", "/.ssh/", "/.DS_Store", "/wp-login.php", "/wp-admin", "/xmlrpc.php", "/phpmyadmin",
  "/pma/", "/cgi-bin/", "/vendor/phpunit", "/server-status", "/actuator/", "/boaform", "/HNAP1", "/config.php", "/.vscode/",
];
const LOGIN_KEYWORDS = ["login", "signin", "sign-in", "logon", "auth", "token", "session", "password", "register", "signup", "admin"];
export const DOOR_PREFIX = "/__skyforge/door/";
export const DOOR_COOKIE = "sf_door";
// Rule metrics whose blocked requests mean "this IP is hostile" and earn a ban.
export const BAN_METRICS = ["tripwire", "decoys"];

export function wafNames(appName) {
  return {
    webAclName: `${appName}-waf`,
    ipSetName: `${appName}-banned`,
    allowSetName: `${appName}-admin-allow`,
    metricPrefix: appName.replace(/[^A-Za-z0-9_-]/g, "-"),
  };
}

function client(credentials, scope = "REGIONAL") {
  return new WAFV2Client({
    region: scope === "CLOUDFRONT" ? "us-east-1" : credentials.region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
  });
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Splits alternatives into regexes under WAF's 200-character limit. */
function regexChunks(prefix, alternatives, suffix) {
  const chunks = [];
  let current = [];
  for (const alternative of alternatives) {
    const candidate = `${prefix}(${[...current, alternative].join("|")})${suffix}`;
    if (candidate.length > 190 && current.length) {
      chunks.push(`${prefix}(${current.join("|")})${suffix}`);
      current = [alternative];
    } else {
      current.push(alternative);
    }
  }
  if (current.length) chunks.push(`${prefix}(${current.join("|")})${suffix}`);
  return chunks;
}

const anyOf = (statements) => (statements.length === 1 ? statements[0] : { OrStatement: { Statements: statements } });
const allOf = (statements) => (statements.length === 1 ? statements[0] : { AndStatement: { Statements: statements } });
const not = (statement) => ({ NotStatement: { Statement: statement } });
const uriRegex = (regex, lowercase = false) => ({
  RegexMatchStatement: {
    RegexString: regex,
    FieldToMatch: { UriPath: {} },
    TextTransformations: [{ Priority: 0, Type: lowercase ? "LOWERCASE" : "NONE" }],
  },
});
const pathsMatch = (paths, { exact = false, lowercase = false } = {}) =>
  anyOf(regexChunks("^", paths.map(escapeRegex), exact ? "$" : "").map((regex) => uriRegex(regex, lowercase)));
const headerContains = (name, value, position = "CONTAINS") => ({
  ByteMatchStatement: {
    SearchString: Buffer.from(value),
    FieldToMatch: { SingleHeader: { Name: name } },
    TextTransformations: [{ Priority: 0, Type: "NONE" }],
    PositionalConstraint: position,
  },
});
const visibility = (metric) => ({ SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: metric.slice(0, 128) });

/**
 * Code-aware tuning: tripwires skip any path the app itself serves (e.g. /wp-admin for WordPress,
 * /actuator for Spring), and login routes found in the source get the strict rate limit.
 */
export function tripwirePathsFor({ framework = "", sourceRoutes = [], extra = [] } = {}) {
  const fw = String(framework).toLowerCase();
  const routes = sourceRoutes.map((route) => String(route).toLowerCase());
  return [...new Set([...TRIPWIRE_PATHS, ...extra])].filter((tripwire) => {
    const path = tripwire.toLowerCase();
    if (/php|laravel|wordpress/.test(fw) && /\.php|wp-|phpmyadmin|pma|vendor/.test(path)) return false;
    if (/spring|java/.test(fw) && path === "/actuator/") return false;
    return !routes.some((route) => route && (route.startsWith(path.replace(/\/$/, "")) || path.startsWith(route.replace(/\/$/, "") + "/")));
  });
}

/** Admin areas: routes from the source that look administrative, plus the conventional /admin. */
export function adminPathsFor({ sourceRoutes = [] } = {}) {
  const found = sourceRoutes
    .map((route) => String(route).split("*")[0].replace(/\/+$/, ""))
    .filter((route) => /^\/(?:[\w-]+\/)*?(admin|administrator|dashboard\/admin|backoffice|staff|manage|cms)(\/|$)/i.test(`${route}/`))
    .map((route) => route.replace(/^(.*?\/(admin|administrator|backoffice|staff|manage|cms))(\/.*)?$/i, "$1"));
  return [...new Set(["/admin", ...found])].filter((route) => route.length > 1).slice(0, 10);
}

// Behind CloudFront every request reaches the ALB from an edge IP; the visitor is the first X-Forwarded-For entry.
const FORWARDED = { HeaderName: "X-Forwarded-For", FallbackBehavior: "MATCH" };

/**
 * Builds the rule list and the custom response bodies it references.
 * Every feature is optional; with only the required inputs this is the original rule set.
 */
export function buildWafConfig({
  appName,
  scanToken,
  ipSetArn,
  allowSetArn = null,
  tripwirePaths = TRIPWIRE_PATHS,
  loginPaths = [],
  underAttack = false,
  forwardedIp = false,
  limits = null,
  decoys = null,
  robots = null,
  adminPaths = [],
  doorToken = null,
  botChallenge = "off",
}) {
  const rateKey = forwardedIp ? { AggregateKeyType: "FORWARDED_IP", ForwardedIPConfig: FORWARDED } : { AggregateKeyType: "IP" };
  const ipSetRef = (arn) => ({ IPSetReferenceStatement: { ARN: arn, ...(forwardedIp ? { IPSetForwardedIPConfig: { ...FORWARDED, Position: "FIRST" } } : {}) } });
  const { metricPrefix } = wafNames(appName);
  const tuned = { ...LIMITS.normal, ...(limits || {}) };
  const effective = underAttack ? LIMITS.underAttack : { global: Math.max(100, tuned.global), login: Math.max(20, tuned.login) };
  const loginAlternatives = [...new Set([...LOGIN_KEYWORDS, ...loginPaths.map((route) => String(route).toLowerCase().replace(/^\/+|\/+$/g, "")).filter((route) => route.length > 2)])]
    .map(escapeRegex);
  const rules = [];
  const bodies = {};
  let priority = 0;
  const add = (name, statement, action, extra = {}) => rules.push({ Name: name, Priority: priority++, Statement: statement, ...action, VisibilityConfig: visibility(`${metricPrefix}-${name}`), ...extra });

  if (scanToken) add("skyforge-scanner", headerContains("x-skyforge-scan", scanToken, "EXACTLY"), { Action: { Allow: {} } });

  const adminTargets = adminPaths.length ? adminPaths : ["/admin"];
  if (doorToken) {
    // Visiting the secret link sets the door cookie and redirects into the admin area.
    add("admin-door", uriRegex(`^${escapeRegex(`${DOOR_PREFIX}${doorToken}`)}/?$`), {
      Action: {
        Block: {
          CustomResponse: {
            ResponseCode: 302,
            ResponseHeaders: [
              { Name: "Location", Value: `${adminTargets[0]}/` },
              { Name: "Set-Cookie", Value: `${DOOR_COOKIE}=${doorToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` },
              { Name: "Cache-Control", Value: "no-store" },
            ],
          },
        },
      },
    });
  }

  add("banned-ips", ipSetRef(ipSetArn), { Action: { Block: {} } });

  if (decoys?.length) {
    for (const decoy of decoys) bodies[decoy.key] = { ContentType: "TEXT_PLAIN", Content: decoy.content };
    // Each decoy body is served at its own paths with HTTP 200 so the scanner believes it found a real file.
    for (const decoy of decoys) {
      add(`decoys-${decoy.key}`, pathsMatch(decoy.paths, { exact: true }), {
        Action: { Block: { CustomResponse: { ResponseCode: 200, CustomResponseBodyKey: decoy.key, ResponseHeaders: [{ Name: "Cache-Control", Value: "no-store" }] } } },
      });
    }
  }
  if (robots) {
    bodies.robots = { ContentType: "TEXT_PLAIN", Content: robots };
    add("robots", uriRegex("^/robots\\.txt$"), { Action: { Block: { CustomResponse: { ResponseCode: 200, CustomResponseBodyKey: "robots" } } } });
  }
  if (tripwirePaths.length) add("tripwire", pathsMatch(tripwirePaths), { Action: { Block: { CustomResponse: { ResponseCode: 404 } } } });

  const lockIps = Boolean(allowSetArn);
  if (lockIps || doorToken) {
    const exemptions = [];
    if (lockIps) exemptions.push(ipSetRef(allowSetArn));
    if (doorToken) exemptions.push(headerContains("cookie", `${DOOR_COOKIE}=${doorToken}`));
    add("admin-lockdown", allOf([pathsMatch(adminTargets, { lowercase: true }), not(anyOf(exemptions))]), { Action: { Block: { CustomResponse: { ResponseCode: 404 } } } });
  }

  const challenge = underAttack ? "all" : botChallenge;
  if (challenge === "all" || challenge === "login") {
    // Only HTML page loads are challenged; API calls, health checks and assets never see a challenge page.
    const html = headerContains("accept", "text/html");
    const scope = challenge === "all" ? html : allOf([html, anyOf(regexChunks("", loginAlternatives, "").map((regex) => uriRegex(regex, true)))]);
    add("bot-challenge", scope, { Action: { Challenge: {} } });
  }

  add("login-rate-limit", {
    RateBasedStatement: {
      Limit: effective.login,
      EvaluationWindowSec: 300,
      ...rateKey,
      ScopeDownStatement: anyOf(regexChunks("", loginAlternatives, "").map((regex) => uriRegex(regex, true))),
    },
  }, { Action: { Block: {} } });
  add("global-rate-limit", { RateBasedStatement: { Limit: effective.global, EvaluationWindowSec: 300, ...rateKey } }, { Action: { Block: {} } });

  for (const group of MANAGED_GROUPS) {
    rules.push({
      Name: group.name,
      Priority: priority++,
      Statement: {
        ManagedRuleGroupStatement: {
          VendorName: "AWS",
          Name: group.name,
          ...(group.countOnly ? { RuleActionOverrides: group.countOnly.map((name) => ({ Name: name, ActionToUse: { Count: {} } })) } : {}),
        },
      },
      OverrideAction: { None: {} },
      VisibilityConfig: visibility(`${metricPrefix}-${group.metric}`),
    });
  }
  return { rules, bodies, limits: effective };
}

/** Backwards-compatible: the rule list only. */
export function buildWafRules(options) {
  return buildWafConfig(options).rules;
}

const retry = async (fn, { attempts = 12, delayMs = 5000, retryOn = /WAFUnavailableEntity|WAFOptimisticLock|WAFAssociatedItem|ThrottlingException/ } = {}) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !retryOn.test(`${error.name} ${error.message}`)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};

const PROPAGATION = /WAFUnavailableEntity|WAFOptimisticLock|WAFAssociatedItem|ThrottlingException|WAFNonexistentItem|couldn.t retrieve/i;

async function findByName(waf, Command, listKey, name, scope) {
  let NextMarker;
  do {
    const page = await waf.send(new Command({ Scope: scope, Limit: 100, ...(NextMarker ? { NextMarker } : {}) }));
    const match = (page[listKey] || []).find((item) => item.Name === name);
    if (match) return match;
    NextMarker = page.NextMarker;
  } while (NextMarker);
  return null;
}

const toCidr = (ip) => (ip.includes("/") ? ip : `${ip}/32`);

async function ensureIpSet(waf, { name, scope, tags, description, addresses = [] }) {
  let ipSet = await findByName(waf, ListIPSetsCommand, "IPSets", name, scope);
  if (!ipSet) {
    ipSet = (await waf.send(new CreateIPSetCommand({ Name: name, Scope: scope, IPAddressVersion: "IPV4", Addresses: (addresses || []).map(toCidr), Description: description, Tags: tags }))).Summary;
  } else if (addresses) {
    await setIpSetAddresses(waf, { name, scope, id: ipSet.Id, addresses });
  }
  return ipSet;
}

async function setIpSetAddresses(waf, { name, scope, id, addresses }) {
  await retry(async () => {
    const current = await waf.send(new GetIPSetCommand({ Name: name, Scope: scope, Id: id }));
    const desired = [...new Set(addresses.map(toCidr))].sort();
    const existing = [...(current.IPSet?.Addresses || [])].sort();
    if (desired.join(",") === existing.join(",")) return;
    await waf.send(new UpdateIPSetCommand({ Name: name, Scope: scope, Id: id, Addresses: desired, LockToken: current.LockToken }));
  });
}

async function deleteIpSetByName(waf, { name, scope, id }) {
  const setId = id || (await findByName(waf, ListIPSetsCommand, "IPSets", name, scope))?.Id;
  if (!setId) return;
  await retry(async () => {
    const current = await waf.send(new GetIPSetCommand({ Name: name, Scope: scope, Id: setId }));
    await waf.send(new DeleteIPSetCommand({ Name: name, Scope: scope, Id: setId, LockToken: current.LockToken }));
  }, { attempts: 24 }).catch((error) => {
    if (!isMissing(error)) throw error;
  });
}

/**
 * Creates or updates the project's web ACL (idempotent). For REGIONAL scope it is attached to the
 * load balancer here; for CLOUDFRONT scope the caller attaches the returned ARN to the distribution.
 */
export async function ensureWebAcl({
  credentials, appName, loadBalancerArn, scanToken, tripwirePaths, loginPaths, underAttack = false, forwardedIp = false,
  scope = "REGIONAL", limits = null, decoys = null, robots = null, adminPaths = [], adminAllowIps = [], doorToken = null, botChallenge = "off",
}) {
  const waf = client(credentials, scope);
  const { webAclName, ipSetName, allowSetName, metricPrefix } = wafNames(appName);
  const tags = [{ Key: "skyforge:managed", Value: "true" }, { Key: "skyforge:app", Value: appName }];

  const ipSet = await ensureIpSet(waf, { name: ipSetName, scope, tags, description: "SkyForge bans - tripwires, decoys, shared attacker list", addresses: null });
  let allowSet = null;
  if (adminAllowIps.length) {
    allowSet = await ensureIpSet(waf, { name: allowSetName, scope, tags, description: "SkyForge admin allowlist", addresses: adminAllowIps });
  }
  const { rules, bodies, limits: effective } = buildWafConfig({
    appName, scanToken, ipSetArn: ipSet.ARN, allowSetArn: allowSet?.ARN || null, tripwirePaths, loginPaths, underAttack, forwardedIp,
    limits, decoys, robots, adminPaths, doorToken, botChallenge,
  });
  const base = {
    Name: webAclName,
    Scope: scope,
    DefaultAction: { Allow: {} },
    Rules: rules,
    VisibilityConfig: visibility(`${metricPrefix}-waf`),
    ...(Object.keys(bodies).length ? { CustomResponseBodies: bodies } : {}),
    // A passed challenge is remembered for an hour, so visitors are not re-challenged on every page.
    ChallengeConfig: { ImmunityTimeProperty: { ImmunityTime: 3600 } },
  };

  let webAcl = await findByName(waf, ListWebACLsCommand, "WebACLs", webAclName, scope);
  if (!webAcl) {
    // A just-created IP set can take a few seconds before a web ACL may reference it.
    webAcl = (await retry(() => waf.send(new CreateWebACLCommand({ ...base, Description: "SkyForge Protected tier", Tags: tags })), { retryOn: PROPAGATION })).Summary;
  } else {
    await retry(async () => {
      const current = await waf.send(new GetWebACLCommand({ Name: webAclName, Scope: scope, Id: webAcl.Id }));
      await waf.send(new UpdateWebACLCommand({ ...base, Id: webAcl.Id, LockToken: current.LockToken }));
    }, { retryOn: PROPAGATION });
  }
  // The allowlist is referenced only while it has entries; drop it once the rule no longer uses it.
  if (!adminAllowIps.length) await deleteIpSetByName(waf, { name: allowSetName, scope }).catch(() => {});
  if (scope === "REGIONAL" && loadBalancerArn) {
    const attached = await waf.send(new GetWebACLForResourceCommand({ ResourceArn: loadBalancerArn })).catch(() => ({}));
    if (attached.WebACL?.ARN !== webAcl.ARN) {
      // A freshly created web ACL takes a few seconds to become associable.
      await retry(() => waf.send(new AssociateWebACLCommand({ WebACLArn: webAcl.ARN, ResourceArn: loadBalancerArn })), { retryOn: PROPAGATION });
    }
  }
  return {
    scope,
    webAclArn: webAcl.ARN, webAclId: webAcl.Id, webAclName,
    ipSetArn: ipSet.ARN, ipSetId: ipSet.Id, ipSetName,
    underAttack, tripwirePaths, loginPaths, forwardedIp,
    limits: effective,
    decoyPaths: (decoys || []).flatMap((decoy) => decoy.paths),
    robots: Boolean(robots),
    adminPaths: allowSet || doorToken ? (adminPaths.length ? adminPaths : ["/admin"]) : [],
    adminAllowIps,
    doorEnabled: Boolean(doorToken),
    botChallenge: underAttack ? "all" : botChallenge,
    ruleCount: rules.length,
  };
}

const isMissing = (error) => /WAFNonexistentItem|NotFound/.test(`${error?.name} ${error?.message}`);

/** Detaches and deletes the web ACL and its IP sets. Missing resources are treated as already deleted. */
export async function deleteWebAcl({ credentials, appName, loadBalancerArn, webAclId, ipSetId, scope = "REGIONAL" }) {
  const waf = client(credentials, scope);
  const { webAclName, ipSetName, allowSetName } = wafNames(appName);
  if (scope === "REGIONAL" && loadBalancerArn) {
    await retry(() => waf.send(new DisassociateWebACLCommand({ ResourceArn: loadBalancerArn }))).catch((error) => {
      if (!isMissing(error) && !/LoadBalancerNotFound|not found|does not exist/i.test(error.message)) throw error;
    });
  }
  const aclId = webAclId || (await findByName(waf, ListWebACLsCommand, "WebACLs", webAclName, scope))?.Id;
  if (aclId) {
    await retry(async () => {
      const current = await waf.send(new GetWebACLCommand({ Name: webAclName, Scope: scope, Id: aclId }));
      await waf.send(new DeleteWebACLCommand({ Name: webAclName, Scope: scope, Id: aclId, LockToken: current.LockToken }));
    }, { attempts: 24 }).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }
  await deleteIpSetByName(waf, { name: ipSetName, scope, id: ipSetId });
  await deleteIpSetByName(waf, { name: allowSetName, scope });
}

/** Lists the project's WAF resources that still exist in both scopes (used by the teardown verification sweep). */
export async function findWafLeftovers({ credentials, appName }) {
  const { webAclName, ipSetName, allowSetName } = wafNames(appName);
  const look = async (scope) => {
    const waf = client(credentials, scope);
    const [webAcl, ipSet, allowSet] = await Promise.all([
      findByName(waf, ListWebACLsCommand, "WebACLs", webAclName, scope),
      findByName(waf, ListIPSetsCommand, "IPSets", ipSetName, scope),
      findByName(waf, ListIPSetsCommand, "IPSets", allowSetName, scope),
    ]);
    return { webAcl, ipSet, allowSet };
  };
  const [regional, cloudfront] = await Promise.all([look("REGIONAL"), look("CLOUDFRONT").catch(() => ({}))]);
  return { ...regional, cloudfront };
}

async function sampled(waf, webAclArn, metric, { hours = 3, scope = "REGIONAL" } = {}) {
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3600 * 1000);
  try {
    const result = await waf.send(new GetSampledRequestsCommand({ WebAclArn: webAclArn, RuleMetricName: metric, Scope: scope, TimeWindow: { StartTime: start, EndTime: end }, MaxItems: 500 }));
    return (result.SampledRequests || []).map((item) => ({
      // Behind CloudFront the client IP is an edge address; the visitor is the first X-Forwarded-For entry.
      ip: String((item.Request?.Headers || []).find((header) => /^x-forwarded-for$/i.test(header.Name || ""))?.Value || item.Request?.ClientIP || "").split(",")[0].trim(),
      country: item.Request?.Country || "??",
      path: item.Request?.URI,
      method: item.Request?.Method,
      userAgent: (item.Request?.Headers || []).find((header) => /^user-agent$/i.test(header.Name || ""))?.Value || "",
      action: item.Action,
      weight: item.Weight || 1,
      rule: item.RuleNameWithinRuleGroup || metric.replace(/^.*?-(tripwire|decoys(?:-\w+)?|robots|admin-door|admin-lockdown|bot-challenge|banned-ips|login-rate-limit|global-rate-limit|ip-reputation|known-bad-inputs|owasp-core|sql-injection|waf)$/, "$1"),
      at: item.Timestamp ? new Date(item.Timestamp).toISOString() : null,
    }));
  } catch {
    return [];
  }
}

const decoyMetrics = (metricPrefix, decoyKeys = []) => decoyKeys.map((key) => `${metricPrefix}-decoys-${key}`);

/** Requests that hit a tripwire or a decoy in the last few hours. */
export async function hostileHits({ credentials, appName, webAclArn, decoyKeys = [], scope = "REGIONAL", hours = 3 }) {
  const waf = client(credentials, scope);
  const { metricPrefix } = wafNames(appName);
  const metrics = [`${metricPrefix}-tripwire`, ...decoyMetrics(metricPrefix, decoyKeys)];
  return (await Promise.all(metrics.map((metric) => sampled(waf, webAclArn, metric, { hours, scope })))).flat();
}

/**
 * Bans IPs that hit a tripwire or decoy for 24 hours, expires old bans, and writes the project's
 * bans plus `sharedIps` (herd immunity) into the IP set. Returns { bans, newBans }.
 * `bans` is [{ ip, until, reason }].
 */
export async function syncTripwireBans({ credentials, appName, webAclArn, ipSetId, bans = [], banHours = 24, ignoreIps = [], sharedIps = [], decoyKeys = [], scope = "REGIONAL" }) {
  const waf = client(credentials, scope);
  const { ipSetName } = wafNames(appName);
  const now = Date.now();
  const active = new Map(bans.filter((ban) => Date.parse(ban.until) > now).map((ban) => [ban.ip, ban]));
  const newBans = [];
  for (const hit of await hostileHits({ credentials, appName, webAclArn, decoyKeys, scope })) {
    if (!hit.ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(hit.ip) || active.has(hit.ip) || ignoreIps.includes(hit.ip)) continue;
    const ban = { ip: hit.ip, until: new Date(now + banHours * 3600 * 1000).toISOString(), reason: `${/decoys/.test(hit.rule) ? "took decoy" : "probed"} ${hit.path}`.slice(0, 120), country: hit.country, userAgent: hit.userAgent.slice(0, 120) };
    active.set(hit.ip, ban);
    newBans.push(ban);
  }
  const list = [...active.values()].slice(0, 5000);
  const shared = sharedIps.filter((ip) => !active.has(ip) && !ignoreIps.includes(ip)).slice(0, Math.max(0, 9000 - list.length));
  await setIpSetAddresses(waf, { name: ipSetName, scope, id: ipSetId, addresses: [...list.map((ban) => ban.ip), ...shared] });
  return { bans: list, newBans, sharedCount: shared.length };
}

const RULE_METRICS = ["banned-ips", "tripwire", "robots", "admin-lockdown", "admin-door", "bot-challenge", "login-rate-limit", "global-rate-limit"];

/** Summary of requests WAF blocked in the last 3 hours (sampled): totals by rule, top IPs, countries, paths. */
export async function attackSummary({ credentials, appName, webAclArn, decoyKeys = [], scope = "REGIONAL", hours = 3 }) {
  const waf = client(credentials, scope);
  const { metricPrefix } = wafNames(appName);
  const metrics = [...RULE_METRICS, ...MANAGED_GROUPS.map((group) => group.metric)].map((metric) => `${metricPrefix}-${metric}`);
  const hits = (await Promise.all([...metrics, ...decoyMetrics(metricPrefix, decoyKeys)].map((metric) => sampled(waf, webAclArn, metric, { hours, scope }))))
    .flat()
    .filter((hit) => hit.action === "BLOCK" || hit.action === "CHALLENGE");
  const top = (key, limit = 8) => Object.entries(hits.reduce((counts, hit) => ({ ...counts, [hit[key]]: (counts[hit[key]] || 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value, count]) => ({ value, count }));
  return {
    windowHours: hours,
    sampledBlocked: hits.length,
    byRule: top("rule", 14),
    topIps: top("ip"),
    topCountries: top("country"),
    topPaths: top("path"),
    recent: hits.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 25),
  };
}

/** Sampled allowed traffic (the web ACL default action), used to tune rate limits to real visitors. */
export async function allowedTrafficSample({ credentials, appName, webAclArn, scope = "REGIONAL", hours = 3 }) {
  const waf = client(credentials, scope);
  return sampled(waf, webAclArn, `${wafNames(appName).metricPrefix}-waf`, { hours, scope });
}

export const WAF_MONTHLY_ESTIMATE = "about $14-20/month (WAF: $5 web ACL + $1 per rule, 9-15 rules depending on features) + $0.60 per million requests";
