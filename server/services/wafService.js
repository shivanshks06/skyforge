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
 * AWS WAF ("Protected" tier) for a project's load balancer: managed OWASP / IP-reputation /
 * known-bad-input rules, per-IP rate limits (stricter on login routes found in the source),
 * honeypot "tripwire" paths that ban the scanner's IP, and an allow rule for SkyForge's own
 * security scanner. Approximate cost: $5 per web ACL + $1 per rule (9) + $0.60 per million requests.
 */

const SCOPE = "REGIONAL";
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

export function wafNames(appName) {
  return { webAclName: `${appName}-waf`, ipSetName: `${appName}-banned`, metricPrefix: appName.replace(/[^A-Za-z0-9_-]/g, "-") };
}

function client(credentials) {
  return new WAFV2Client({
    region: credentials.region,
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
const uriRegex = (regex, lowercase = false) => ({
  RegexMatchStatement: {
    RegexString: regex,
    FieldToMatch: { UriPath: {} },
    TextTransformations: [{ Priority: 0, Type: lowercase ? "LOWERCASE" : "NONE" }],
  },
});
const visibility = (metric) => ({ SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: metric.slice(0, 128) });

/**
 * Code-aware tuning: tripwires skip any path the app itself serves (e.g. /wp-admin for WordPress,
 * /actuator for Spring), and login routes found in the source get the strict rate limit.
 */
export function tripwirePathsFor({ framework = "", sourceRoutes = [] } = {}) {
  const fw = String(framework).toLowerCase();
  const routes = sourceRoutes.map((route) => String(route).toLowerCase());
  return TRIPWIRE_PATHS.filter((tripwire) => {
    const path = tripwire.toLowerCase();
    if (/php|laravel|wordpress/.test(fw) && /\.php|wp-|phpmyadmin|pma|vendor/.test(path)) return false;
    if (/spring|java/.test(fw) && path === "/actuator/") return false;
    return !routes.some((route) => route && (route.startsWith(path.replace(/\/$/, "")) || path.startsWith(route.replace(/\/$/, "") + "/")));
  });
}

// Behind CloudFront every request reaches the ALB from an edge IP; the visitor is the first X-Forwarded-For entry.
const FORWARDED = { HeaderName: "X-Forwarded-For", FallbackBehavior: "MATCH" };

export function buildWafRules({ appName, scanToken, ipSetArn, tripwirePaths = TRIPWIRE_PATHS, loginPaths = [], underAttack = false, forwardedIp = false }) {
  const rateKey = forwardedIp ? { AggregateKeyType: "FORWARDED_IP", ForwardedIPConfig: FORWARDED } : { AggregateKeyType: "IP" };
  const { metricPrefix } = wafNames(appName);
  const limits = underAttack ? LIMITS.underAttack : LIMITS.normal;
  const loginAlternatives = [...new Set([...LOGIN_KEYWORDS, ...loginPaths.map((route) => String(route).toLowerCase().replace(/^\/+|\/+$/g, "")).filter((route) => route.length > 2)])]
    .map(escapeRegex);
  const rules = [];
  let priority = 0;
  if (scanToken) {
    rules.push({
      Name: "skyforge-scanner",
      Priority: priority++,
      Statement: {
        ByteMatchStatement: {
          SearchString: Buffer.from(scanToken),
          FieldToMatch: { SingleHeader: { Name: "x-skyforge-scan" } },
          TextTransformations: [{ Priority: 0, Type: "NONE" }],
          PositionalConstraint: "EXACTLY",
        },
      },
      Action: { Allow: {} },
      VisibilityConfig: visibility(`${metricPrefix}-scanner`),
    });
  }
  rules.push({
    Name: "banned-ips",
    Priority: priority++,
    Statement: { IPSetReferenceStatement: { ARN: ipSetArn, ...(forwardedIp ? { IPSetForwardedIPConfig: { ...FORWARDED, Position: "FIRST" } } : {}) } },
    Action: { Block: {} },
    VisibilityConfig: visibility(`${metricPrefix}-banned`),
  });
  if (tripwirePaths.length) {
    rules.push({
      Name: "tripwire",
      Priority: priority++,
      Statement: anyOf(regexChunks("^", tripwirePaths.map(escapeRegex), "").map((regex) => uriRegex(regex))),
      Action: { Block: {} },
      VisibilityConfig: visibility(`${metricPrefix}-tripwire`),
    });
  }
  rules.push({
    Name: "login-rate-limit",
    Priority: priority++,
    Statement: {
      RateBasedStatement: {
        Limit: limits.login,
        EvaluationWindowSec: 300,
        ...rateKey,
        ScopeDownStatement: anyOf(regexChunks("", loginAlternatives, "").map((regex) => uriRegex(regex, true))),
      },
    },
    Action: { Block: {} },
    VisibilityConfig: visibility(`${metricPrefix}-login-rate`),
  });
  rules.push({
    Name: "global-rate-limit",
    Priority: priority++,
    Statement: { RateBasedStatement: { Limit: limits.global, EvaluationWindowSec: 300, ...rateKey } },
    Action: { Block: {} },
    VisibilityConfig: visibility(`${metricPrefix}-global-rate`),
  });
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
  return rules;
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

async function findByName(waf, Command, listKey, name) {
  let NextMarker;
  do {
    const page = await waf.send(new Command({ Scope: SCOPE, Limit: 100, ...(NextMarker ? { NextMarker } : {}) }));
    const match = (page[listKey] || []).find((item) => item.Name === name);
    if (match) return match;
    NextMarker = page.NextMarker;
  } while (NextMarker);
  return null;
}

/** Creates or updates the project's web ACL and attaches it to the load balancer (idempotent). */
export async function ensureWebAcl({ credentials, appName, loadBalancerArn, scanToken, tripwirePaths, loginPaths, underAttack = false, forwardedIp = false }) {
  const waf = client(credentials);
  const { webAclName, ipSetName, metricPrefix } = wafNames(appName);
  const tags = [{ Key: "skyforge:managed", Value: "true" }, { Key: "skyforge:app", Value: appName }];

  let ipSet = await findByName(waf, ListIPSetsCommand, "IPSets", ipSetName);
  if (!ipSet) {
    const created = await waf.send(new CreateIPSetCommand({ Name: ipSetName, Scope: SCOPE, IPAddressVersion: "IPV4", Addresses: [], Description: "SkyForge tripwire bans", Tags: tags }));
    ipSet = created.Summary;
  }
  const rules = buildWafRules({ appName, scanToken, ipSetArn: ipSet.ARN, tripwirePaths, loginPaths, underAttack, forwardedIp });
  const base = { Name: webAclName, Scope: SCOPE, DefaultAction: { Allow: {} }, Rules: rules, VisibilityConfig: visibility(`${metricPrefix}-waf`) };

  let webAcl = await findByName(waf, ListWebACLsCommand, "WebACLs", webAclName);
  if (!webAcl) {
    webAcl = (await waf.send(new CreateWebACLCommand({ ...base, Description: "SkyForge Protected tier", Tags: tags }))).Summary;
  } else {
    await retry(async () => {
      const current = await waf.send(new GetWebACLCommand({ Name: webAclName, Scope: SCOPE, Id: webAcl.Id }));
      await waf.send(new UpdateWebACLCommand({ ...base, Id: webAcl.Id, LockToken: current.LockToken }));
    });
  }
  if (loadBalancerArn) {
    const attached = await waf.send(new GetWebACLForResourceCommand({ ResourceArn: loadBalancerArn })).catch(() => ({}));
    if (attached.WebACL?.ARN !== webAcl.ARN) {
      // A freshly created web ACL takes a few seconds to become associable.
      await retry(() => waf.send(new AssociateWebACLCommand({ WebACLArn: webAcl.ARN, ResourceArn: loadBalancerArn })));
    }
  }
  return {
    webAclArn: webAcl.ARN, webAclId: webAcl.Id, webAclName,
    ipSetArn: ipSet.ARN, ipSetId: ipSet.Id, ipSetName,
    underAttack, tripwirePaths, loginPaths, forwardedIp,
  };
}

const isMissing = (error) => /WAFNonexistentItem|NotFound/.test(`${error?.name} ${error?.message}`);

/** Detaches and deletes the web ACL and IP set. Missing resources are treated as already deleted. */
export async function deleteWebAcl({ credentials, appName, loadBalancerArn, webAclId, ipSetId }) {
  const waf = client(credentials);
  const { webAclName, ipSetName } = wafNames(appName);
  if (loadBalancerArn) {
    await retry(() => waf.send(new DisassociateWebACLCommand({ ResourceArn: loadBalancerArn }))).catch((error) => {
      if (!isMissing(error) && !/LoadBalancerNotFound|not found|does not exist/i.test(error.message)) throw error;
    });
  }
  const aclId = webAclId || (await findByName(waf, ListWebACLsCommand, "WebACLs", webAclName))?.Id;
  if (aclId) {
    await retry(async () => {
      const current = await waf.send(new GetWebACLCommand({ Name: webAclName, Scope: SCOPE, Id: aclId }));
      await waf.send(new DeleteWebACLCommand({ Name: webAclName, Scope: SCOPE, Id: aclId, LockToken: current.LockToken }));
    }, { attempts: 24 }).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }
  const setId = ipSetId || (await findByName(waf, ListIPSetsCommand, "IPSets", ipSetName))?.Id;
  if (setId) {
    await retry(async () => {
      const current = await waf.send(new GetIPSetCommand({ Name: ipSetName, Scope: SCOPE, Id: setId }));
      await waf.send(new DeleteIPSetCommand({ Name: ipSetName, Scope: SCOPE, Id: setId, LockToken: current.LockToken }));
    }, { attempts: 24 }).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }
}

/** Lists the project's WAF resources that still exist (used by the teardown verification sweep). */
export async function findWafLeftovers({ credentials, appName }) {
  const waf = client(credentials);
  const { webAclName, ipSetName } = wafNames(appName);
  const [webAcl, ipSet] = await Promise.all([
    findByName(waf, ListWebACLsCommand, "WebACLs", webAclName),
    findByName(waf, ListIPSetsCommand, "IPSets", ipSetName),
  ]);
  return { webAcl, ipSet };
}

async function sampled(waf, webAclArn, metric, hours = 3) {
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3600 * 1000);
  try {
    const result = await waf.send(new GetSampledRequestsCommand({ WebAclArn: webAclArn, RuleMetricName: metric, Scope: SCOPE, TimeWindow: { StartTime: start, EndTime: end }, MaxItems: 500 }));
    return (result.SampledRequests || []).map((item) => ({
      // Behind CloudFront the client IP is an edge address; the visitor is the first X-Forwarded-For entry.
      ip: String((item.Request?.Headers || []).find((header) => /^x-forwarded-for$/i.test(header.Name || ""))?.Value || item.Request?.ClientIP || "").split(",")[0].trim(),
      country: item.Request?.Country || "??",
      path: item.Request?.URI,
      method: item.Request?.Method,
      action: item.Action,
      rule: item.RuleNameWithinRuleGroup || metric.replace(/^.*?-(tripwire|banned|login-rate|global-rate|ip-reputation|known-bad-inputs|owasp-core|sql-injection)$/, "$1"),
      at: item.Timestamp ? new Date(item.Timestamp).toISOString() : null,
    }));
  } catch {
    return [];
  }
}

/**
 * Bans IPs that hit a tripwire for 24 hours and expires old bans. Returns the updated ban list.
 * `bans` is [{ ip, until, reason }].
 */
export async function syncTripwireBans({ credentials, appName, webAclArn, ipSetId, bans = [], banHours = 24, ignoreIps = [] }) {
  const waf = client(credentials);
  const { metricPrefix, ipSetName } = wafNames(appName);
  const now = Date.now();
  const active = new Map(bans.filter((ban) => Date.parse(ban.until) > now).map((ban) => [ban.ip, ban]));
  for (const hit of await sampled(waf, webAclArn, `${metricPrefix}-tripwire`)) {
    if (!hit.ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(hit.ip) || active.has(hit.ip) || ignoreIps.includes(hit.ip)) continue;
    active.set(hit.ip, { ip: hit.ip, until: new Date(now + banHours * 3600 * 1000).toISOString(), reason: `probed ${hit.path}`.slice(0, 120), country: hit.country });
  }
  const list = [...active.values()].slice(0, 5000);
  await retry(async () => {
    const current = await waf.send(new GetIPSetCommand({ Name: ipSetName, Scope: SCOPE, Id: ipSetId }));
    const desired = list.map((ban) => `${ban.ip}/32`).sort();
    const existing = [...(current.IPSet?.Addresses || [])].sort();
    if (desired.join(",") === existing.join(",")) return;
    await waf.send(new UpdateIPSetCommand({ Name: ipSetName, Scope: SCOPE, Id: ipSetId, Addresses: desired, LockToken: current.LockToken }));
  });
  return list;
}

/** Summary of requests WAF blocked in the last 3 hours (sampled): totals by rule, top IPs, countries, paths. */
export async function attackSummary({ credentials, appName, webAclArn }) {
  const waf = client(credentials);
  const { metricPrefix } = wafNames(appName);
  const metrics = ["banned", "tripwire", "login-rate", "global-rate", ...MANAGED_GROUPS.map((group) => group.metric)];
  const hits = (await Promise.all(metrics.map((metric) => sampled(waf, webAclArn, `${metricPrefix}-${metric}`))))
    .flat()
    .filter((hit) => hit.action === "BLOCK");
  const top = (key, limit = 8) => Object.entries(hits.reduce((counts, hit) => ({ ...counts, [hit[key]]: (counts[hit[key]] || 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value, count]) => ({ value, count }));
  return {
    windowHours: 3,
    sampledBlocked: hits.length,
    byRule: top("rule", 12),
    topIps: top("ip"),
    topCountries: top("country"),
    topPaths: top("path"),
    recent: hits.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20),
  };
}

export const WAF_MONTHLY_ESTIMATE = "about $14/month (WAF: $5 web ACL + $9 for 9 rules) + $0.60 per million requests";
