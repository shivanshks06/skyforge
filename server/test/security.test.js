import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { buildWafRules, tripwirePathsFor } from "../services/wafService.js";
import { scanCodeSecurity, runSelfPentest, scoreFindings, extractRoutes } from "../services/securityScanner.js";
import { deterministicFix } from "../services/fixPullRequest.js";

test("firewall rules: scanner allow first, bans, tripwires, rate limits, managed groups", () => {
  const rules = buildWafRules({ appName: "todo-abc", scanToken: "t0k3n", ipSetArn: "arn:ipset", tripwirePaths: ["/.env", "/wp-login.php"], loginPaths: ["/accounts/login/"] });
  assert.deepEqual(rules.map((rule) => rule.Name), [
    "skyforge-scanner", "banned-ips", "tripwire", "login-rate-limit", "global-rate-limit",
    "AWSManagedRulesAmazonIpReputationList", "AWSManagedRulesKnownBadInputsRuleSet", "AWSManagedRulesCommonRuleSet", "AWSManagedRulesSQLiRuleSet",
  ]);
  assert.deepEqual(rules.map((rule) => rule.Priority), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(rules[0].Action.Allow && rules[1].Action.Block);
  const tripwire = JSON.stringify(rules[2].Statement);
  assert.match(tripwire, /\^\(\/\\\\\.env\|\/wp-login\\\\\.php\)/);
  assert.equal(rules[3].Statement.RateBasedStatement.Limit, 100);
  assert.match(JSON.stringify(rules[3].Statement), /accounts\/login/);
  assert.equal(rules[4].Statement.RateBasedStatement.Limit, 2000);
  // Large uploads must not be blocked by the managed core rule set.
  assert.deepEqual(rules[7].Statement.ManagedRuleGroupStatement.RuleActionOverrides, [{ Name: "SizeRestrictions_BODY", ActionToUse: { Count: {} } }]);
  const attack = buildWafRules({ appName: "todo-abc", ipSetArn: "arn:ipset", underAttack: true });
  assert.equal(attack.find((rule) => rule.Name === "global-rate-limit").Statement.RateBasedStatement.Limit, 300);
  assert.equal(attack.find((rule) => rule.Name === "login-rate-limit").Statement.RateBasedStatement.Limit, 20);
  for (const rule of attack) {
    for (const regex of JSON.stringify(rule.Statement).matchAll(/"RegexString":"((?:[^"\\]|\\.)*)"/g)) assert.ok(JSON.parse(`"${regex[1]}"`).length <= 200);
  }
});

test("tripwires skip paths the app itself serves", () => {
  assert.ok(!tripwirePathsFor({ framework: "Laravel" }).some((path) => /php|wp-/.test(path)));
  assert.ok(!tripwirePathsFor({ framework: "Spring Boot" }).includes("/actuator/"));
  assert.ok(!tripwirePathsFor({ framework: "Express", sourceRoutes: ["/server-status"] }).includes("/server-status"));
  assert.ok(tripwirePathsFor({ framework: "Django" }).includes("/.env"));
});

test("code scan finds debug mode, hard-coded secrets, committed env files; deterministic fixes apply", () => {
  const settings = "import os\nSECRET_KEY = '8)810zj@#^2xp=1=2rkozbv8#'\nDEBUG = True\nALLOWED_HOSTS = ['*']\n";
  const findings = scanCodeSecurity([
    { path: "todoApp/settings.py", content: settings },
    { path: ".env", content: "" },
    { path: "config/keys.js", content: "const k = 'AKIAIOSFODNN7EXAMPLE';" },
    { path: "tests/settings.py", content: "DEBUG = True" },
  ]);
  const rules = findings.map((item) => item.rule).sort();
  assert.deepEqual(rules, ["aws-access-key", "committed-env-file", "django-allowed-hosts", "django-debug", "django-secret-key"]);
  const debug = findings.find((item) => item.rule === "django-debug");
  assert.equal(debug.location, "todoApp/settings.py:3");
  const fixed = deterministicFix(debug, settings);
  assert.match(fixed.content, /^DEBUG = os\.environ\.get\("DJANGO_DEBUG", "False"\)\.lower\(\) == "true"$/m);
  const secret = deterministicFix(findings.find((item) => item.rule === "django-secret-key"), "SECRET_KEY = 'abcdefghijkl'\n");
  assert.match(secret.content, /^import os\nSECRET_KEY = os\.environ\["DJANGO_SECRET_KEY"\]/);
  assert.deepEqual(secret.envVars, ["DJANGO_SECRET_KEY"]);
});

test("routes are extracted from Express, Django, Flask, and Next.js sources", () => {
  const routes = extractRoutes([
    { path: "server.js", content: "app.post('/api/auth/login', h); router.get('/users/:id', h);" },
    { path: "app/urls.py", content: "urlpatterns = [path('accounts/login/', v), path('todos/<int:pk>/', v)]" },
    { path: "app.py", content: "@app.route('/signup')\ndef s(): pass" },
    { path: "app/dashboard/page.tsx", content: "export default function P() {}" },
  ]);
  for (const route of ["/api/auth/login", "/users/*", "/accounts/login/", "/todos/*/", "/signup", "/dashboard"]) assert.ok(routes.includes(route), route);
});

test("self-pentest flags real exposures on a vulnerable server and scores them", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/.git/HEAD") return res.end("ref: refs/heads/main\n");
    if (req.url.startsWith("/?q=")) return res.end(`<p>Results for ${decodeURIComponent(req.url.split("q=")[1].split("&")[0])}</p>`);
    if (req.url.includes("not-found")) { res.statusCode = 404; return res.end("Page not found. Using the URLconf defined in todoApp.urls"); }
    res.setHeader("X-Powered-By", "Express/4.18.2");
    return res.end("<h1>home</h1>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { findings } = await runSelfPentest(`http://127.0.0.1:${server.address().port}/`, { scanToken: "t" });
    const rules = findings.map((item) => item.rule);
    for (const rule of ["exposed-git", "reflected-input", "debug-error-page", "missing-security-headers", "version-banner", "no-https"]) assert.ok(rules.includes(rule), rule);
    assert.ok(!rules.includes("exposed-env"));
    const { score, grade } = scoreFindings(findings);
    assert.ok(score < 40 && grade === "F", `${score} ${grade}`);
  } finally {
    server.close();
  }
});
