import test from "node:test";
import assert from "node:assert/strict";
import { buildWafConfig, adminPathsFor, tripwirePathsFor, DOOR_PREFIX } from "../services/wafService.js";
import { firewallDecoys, robotsBait, staticDecoyObjects, appServesRobots, BAIT_PATHS, newDoorToken } from "../services/deceptionService.js";
import { egressPortsFor, codePermissionsFor, dependenciesFor, attackSurfaceFor, diffAttackSurface, secretsInPatch, isSensitiveFile } from "../services/securityPolicy.js";
import { tunedLimits, projectMonthlyCost } from "../services/securityAutomation.js";
import { normalizeAlertSettings, publicAlertSettings, formatAlert, sendAlert } from "../services/alertService.js";
import { normalizeSecuritySettings, DEFAULT_SETTINGS } from "../services/securityService.js";
import { blastRadius, STATE_CHANGING, replayBlockedAttacks } from "../services/redTeamService.js";
import redis from "../redis/connection.js";
import prisma from "../config/db.js";

test.after(async () => {
  redis.disconnect();
  await prisma.$disconnect();
});

// WAF byte matches are Buffers; show them as text in assertions.
const json = (value) => JSON.stringify(value, (_key, item) => (item?.type === "Buffer" && Array.isArray(item.data) ? Buffer.from(item.data).toString() : item));
const honey = { appName: "shop-abc123", honeyKeyId: "AKIAHONEYKEY00000000", honeySecret: "honeysecretvalue0000000000000000000000000" };

test("firewall with every feature: order, decoy bodies, door, lockdown, challenge", () => {
  const decoys = firewallDecoys({ ...honey, servedRoutes: ["/env"] });
  const { rules, bodies, limits } = buildWafConfig({
    appName: "shop-abc123", scanToken: "tok", ipSetArn: "arn:ban", allowSetArn: "arn:allow",
    decoys, robots: robotsBait(), adminPaths: ["/admin", "/staff"], doorToken: "door123", botChallenge: "login",
    tripwirePaths: tripwirePathsFor({ extra: BAIT_PATHS }), loginPaths: ["/accounts/login"], limits: { global: 900, login: 40 },
  });
  const names = rules.map((rule) => rule.Name);
  assert.deepEqual(names.slice(0, 9), ["skyforge-scanner", "admin-door", "banned-ips", "decoys-env", "decoys-aws", "robots", "tripwire", "admin-lockdown", "bot-challenge"]);
  assert.deepEqual(rules.map((rule) => rule.Priority), rules.map((_, index) => index));
  // Decoys answer 200 with a body that holds the honey key; /env is served by the app so it is not shadowed.
  const env = rules.find((rule) => rule.Name === "decoys-env");
  assert.equal(env.Action.Block.CustomResponse.ResponseCode, 200);
  assert.match(bodies.env.Content, /AKIAHONEYKEY00000000/);
  assert.ok(!JSON.stringify(env.Statement).includes('"^(/env)'));
  assert.ok(bodies.env.Content.length < 4096 && bodies.aws.Content.length < 4096);
  assert.match(bodies.robots.Content, /Disallow: \/admin-backup\//);
  // The door sets a cookie and redirects; lockdown exempts the allowlist or the cookie.
  const door = rules.find((rule) => rule.Name === "admin-door").Action.Block.CustomResponse;
  assert.equal(door.ResponseCode, 302);
  assert.ok(door.ResponseHeaders.some((header) => header.Name === "Set-Cookie" && header.Value.startsWith("sf_door=door123;")));
  const lockdown = json(rules.find((rule) => rule.Name === "admin-lockdown").Statement);
  assert.match(lockdown, /NotStatement/);
  assert.match(lockdown, /arn:allow/);
  assert.match(lockdown, /sf_door=door123/);
  assert.equal(rules.find((rule) => rule.Name === "bot-challenge").Action.Challenge !== undefined, true);
  assert.deepEqual(limits, { global: 900, login: 40 });
  assert.equal(rules.find((rule) => rule.Name === "global-rate-limit").Statement.RateBasedStatement.Limit, 900);
  for (const rule of rules) {
    for (const regex of JSON.stringify(rule.Statement).matchAll(/"RegexString":"((?:[^"\\]|\\.)*)"/g)) assert.ok(JSON.parse(`"${regex[1]}"`).length <= 200);
  }
  // Behind CloudFront every IP-based rule reads X-Forwarded-For.
  const forwarded = buildWafConfig({ appName: "x", ipSetArn: "arn:ban", allowSetArn: "arn:allow", adminPaths: ["/admin"], forwardedIp: true }).rules;
  assert.match(JSON.stringify(forwarded.find((rule) => rule.Name === "admin-lockdown")), /IPSetForwardedIPConfig/);
});

test("under attack mode challenges every page load and tightens limits", () => {
  const { rules, limits } = buildWafConfig({ appName: "x", ipSetArn: "arn", underAttack: true, limits: { global: 9000, login: 400 } });
  assert.deepEqual(limits, { global: 300, login: 20 });
  const challenge = rules.find((rule) => rule.Name === "bot-challenge");
  assert.ok(challenge.Action.Challenge);
  assert.match(json(challenge.Statement), /text\/html/);
  assert.equal(json(challenge.Statement).includes("login"), false);
});

test("admin paths come from the source; door tokens are long and URL safe", () => {
  assert.deepEqual(adminPathsFor({ sourceRoutes: ["/api/users", "/admin/*", "/backoffice/orders", "/manage"] }).sort(), ["/admin", "/backoffice", "/manage"]);
  const token = newDoorToken();
  assert.match(token, /^[a-z2-9]{32}$/);
  assert.ok(DOOR_PREFIX.startsWith("/__skyforge/"));
});

test("static decoys and robots detection", () => {
  const objects = staticDecoyObjects({ ...honey, hasRobots: false });
  assert.deepEqual(objects.map((object) => object.key), [".env", ".env.production", ".aws/credentials", "robots.txt"]);
  assert.equal(staticDecoyObjects({ ...honey, hasRobots: true }).some((object) => object.key === "robots.txt"), false);
  assert.ok(appServesRobots([{ path: "public/robots.txt", content: "" }]));
  assert.ok(!appServesRobots([{ path: "src/App.jsx", content: "export default 1" }]));
});

test("outbound ports come from env URLs and libraries", () => {
  const ports = egressPortsFor({
    envValues: { DATABASE_URL: "postgres://u:p@db.example.com/app", REDIS_URL: "rediss://cache.example.com:6390", SMTP_PORT: "2525", PORT: "8000" },
    sourceFiles: [{ path: "package.json", content: '{"dependencies":{"mongoose":"^8"}}' }],
  });
  assert.deepEqual(ports, [80, 443, 2525, 5432, 6390, 27017]);
  assert.deepEqual(egressPortsFor({}), [80, 443]);
});

test("AWS permissions are generated from SDK calls in the code", () => {
  const result = codePermissionsFor({
    envValues: { S3_BUCKET: "my-uploads" },
    sourceFiles: [
      { path: "src/upload.js", content: 'import { S3Client, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";\nimport { SendMessageCommand } from "@aws-sdk/client-sqs";' },
      { path: "app/mail.py", content: 'import boto3\nses = boto3.client("ses")\nses.send_email(Source="a")' },
      { path: "node_modules/x/index.js", content: 'import { DeleteBucketCommand } from "@aws-sdk/client-s3";' },
    ],
  });
  assert.deepEqual(result.actions, ["s3:ListBucket", "s3:PutObject", "ses:SendEmail", "sqs:SendMessage"]);
  const s3 = result.policy.Statement.find((statement) => statement.Sid === "S3FromCode");
  assert.deepEqual(s3.Resource, ["arn:aws:s3:::my-uploads", "arn:aws:s3:::my-uploads/*"]);
  assert.equal(codePermissionsFor({ sourceFiles: [{ path: "a.js", content: "console.log(1)" }] }).policy, null);
});

test("dependencies are read from lockfiles for CVE lookups", () => {
  const deps = dependenciesFor([
    { path: "package-lock.json", content: JSON.stringify({ packages: { "": {}, "node_modules/express": { version: "4.17.1" }, "node_modules/a/node_modules/qs": { version: "6.5.2" } } }) },
    { path: "requirements.txt", content: "Django==3.2.4\nrequests>=2\n" },
    { path: "go.mod", content: "module x\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n" },
  ]);
  const keys = deps.map((dep) => `${dep.ecosystem}:${dep.name}@${dep.version}`).sort();
  assert.deepEqual(keys, ["Go:github.com/gin-gonic/gin@1.9.1", "PyPI:django@3.2.4", "npm:express@4.17.1", "npm:qs@6.5.2"]);
});

test("attack surface diff highlights risky changes", () => {
  const before = attackSurfaceFor({ sourceFiles: [{ path: "app.js", content: 'app.get("/", h); app.post("/login", h);' }], envKeys: ["A"], port: 3000 });
  const after = attackSurfaceFor({ sourceFiles: [{ path: "app.js", content: 'app.get("/", h); app.post("/login", h); app.get("/admin/export", h); app.get("/debug/vars", h);' }], envKeys: ["A", "B"], port: 3000, permissions: ["s3:GetObject"] });
  const diff = diffAttackSurface(before, after);
  assert.equal(diff.risk, "high");
  assert.ok(diff.highlights.some((line) => line.includes("/admin/export")));
  assert.ok(diff.highlights.some((line) => line.includes("/debug/vars")));
  assert.deepEqual(diffAttackSurface(after, after).risk, "none");
  assert.equal(diffAttackSurface(null, after).first, true);
});

test("pushed secrets are found in added lines only", () => {
  const patch = "@@ -1,2 +1,3 @@\n const a = 1;\n-const old = 'AKIAABCDEFGHIJKLMNOP';\n+const key = 'AKIAQWERTYUIOPASDFGH';\n+const b = 2;";
  const hits = secretsInPatch(patch);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule, "aws-access-key");
  assert.equal(hits[0].line, 2);
  assert.ok(isSensitiveFile(".env") && isSensitiveFile("config/.env.production") && isSensitiveFile("keys/server.pem"));
  assert.ok(!isSensitiveFile(".env.example") && !isSensitiveFile("src/env.js"));
});

test("self-tuning limits follow the busiest real visitor", () => {
  const samples = [
    ...Array.from({ length: 30 }, () => ({ ip: "1.1.1.1", path: "/", weight: 1 })),
    ...Array.from({ length: 10 }, () => ({ ip: "2.2.2.2", path: "/login", weight: 1 })),
  ];
  const limits = tunedLimits({ samples, peakFiveMinute: 800 });
  assert.equal(limits.global, 1800); // 75% of 800 = 600, x3
  assert.equal(limits.login, 500); // 25% of 800 = 200, x3 = 600, capped at 500
  assert.equal(tunedLimits({ samples: samples.slice(0, 5), peakFiveMinute: 800 }), null);
  assert.equal(tunedLimits({ samples, peakFiveMinute: 10 }).global, 500);
});

test("denial-of-wallet projection grows with traffic", () => {
  const idle = projectMonthlyCost({ cpu: 0.5, memoryGb: 1 });
  const flood = projectMonthlyCost({ cpu: 0.5, memoryGb: 1, requests24h: 50_000_000, bytes24h: 500e9, protectedTier: true });
  assert.ok(idle.total > 20 && idle.total < 45, `idle ${idle.total}`);
  assert.ok(flood.total > idle.total + 1000, `flood ${flood.total}`);
  assert.ok(projectMonthlyCost({ hasAlb: false }).total < 1);
});

test("alert settings validate channels and never return secrets", async () => {
  await assert.rejects(normalizeAlertSettings({ slack: { enabled: true, webhookUrl: "https://example.com/hook" } }), /Slack/);
  await assert.rejects(normalizeAlertSettings({ telegram: { enabled: true, botToken: "nope", chatId: "1" } }), /Telegram/);
  await assert.rejects(normalizeAlertSettings({ webhook: { enabled: true, url: "http://example.com" } }), /https/);
  await assert.rejects(normalizeAlertSettings({ webhook: { enabled: true, url: "https://127.0.0.1/x" } }), /public/);
  const saved = await normalizeAlertSettings({
    minSeverity: "high",
    slack: { enabled: true, webhookUrl: "https://hooks.slack.com/services/T000/B000/xyz" },
    discord: { enabled: true, webhookUrl: "https://discord.com/api/webhooks/123456/abc-DEF_1" },
    telegram: { enabled: true, botToken: "123456789:AAEhBP0av18wAz_abcdefghijklmnopqrstu", chatId: "-100123456" },
    email: { enabled: true, host: "smtp.gmail.com", port: 587, user: "me@gmail.com", password: "app-password", to: "me@gmail.com, ops@example.com" },
  });
  assert.equal(saved.minSeverity, "high");
  assert.match(saved.slack.webhookUrl, /^enc:|^v1:|:/);
  assert.notEqual(saved.email.password, "app-password");
  const shown = publicAlertSettings(saved);
  assert.equal(shown.slack.webhookUrl, "********");
  assert.equal(shown.email.password, "********");
  assert.equal(shown.email.host, "smtp.gmail.com");
  // Re-saving with the mask keeps the stored secret.
  const again = await normalizeAlertSettings({ ...shown, slack: { enabled: true, webhookUrl: "********" } }, saved);
  assert.equal(publicAlertSettings(again).slack.webhookUrl, "********");
  assert.equal(again.slack.webhookUrl.length > 20, true);
  // Below the minimum severity nothing is sent.
  assert.deepEqual(await sendAlert(saved, { severity: "medium", title: "x", projectName: "p" }), []);
});

test("alert text includes actions and next steps", () => {
  const text = formatAlert({ severity: "critical", title: "Canary used", projectName: "shop", summary: "Leak.", actions: ["Under Attack on"], nextSteps: ["Rotate secrets"], link: "https://app/x" });
  assert.match(text, /\[CRITICAL\] Canary used/);
  assert.match(text, /SkyForge already did:\n• Under Attack on/);
  assert.match(text, /What you should do:\n• Rotate secrets/);
});

test("security settings are validated", () => {
  const next = normalizeSecuritySettings({ adminAllowIps: "203.0.113.4, 198.51.100.0/24", botChallenge: "login", walletBudgetUsd: "50", egressLockdown: true }, DEFAULT_SETTINGS);
  assert.deepEqual(next.adminAllowIps, ["203.0.113.4", "198.51.100.0/24"]);
  assert.equal(next.walletBudgetUsd, 50);
  assert.equal(next.egressLockdown, true);
  assert.throws(() => normalizeSecuritySettings({ adminAllowIps: ["999.1.1.1"] }), /not a valid/);
  assert.throws(() => normalizeSecuritySettings({ botChallenge: "captcha" }), /Bot challenge/);
  assert.throws(() => normalizeSecuritySettings({ securityGate: "maybe" }), /gate/);
});

test("blast radius scores secrets, permissions and network reach", () => {
  const project = { envConfig: { DATABASE_URL: "x", STRIPE_SECRET_KEY: "y", APP_NAME: "z" }, protection: { canary: { accessKeyId: "AKIA" } } };
  const open = blastRadius({ project, taskRole: { inline: [{ document: { Statement: [{ Action: "s3:*" }] } }], attached: [] } });
  assert.equal(open.wildcardPermissions, true);
  assert.equal(open.level, "high");
  assert.deepEqual(open.secrets.sort(), ["DATABASE_URL", "STRIPE_SECRET_KEY"]);
  const tight = blastRadius({ project, taskRole: { inline: [], attached: [] }, egressPorts: [443, 5432], egressLockdown: true });
  assert.ok(tight.score < open.score);
  assert.equal(tight.network.restricted, true);
});

test("red team and replay never request routes that could change data", async () => {
  for (const route of ["/1/delete", "/items/7/update", "/add/", "/logout", "/account/reset-password", "/api/orders/cancel"]) assert.ok(STATE_CHANGING.test(route), route);
  for (const route of ["/todos/", "/admin/", "/api/users/1", "/blog/", "/address", "/orders/1", "/news", "/editor"]) assert.ok(!STATE_CHANGING.test(route), route);
  // Unreachable host: only the non-destructive paths are attempted.
  const result = await replayBlockedAttacks({ liveUrl: "http://127.0.0.1:9", scanToken: "t", blocked: [{ path: "/1/delete", method: "GET" }, { path: "/.env", method: "GET" }, { path: "/login", method: "POST" }] });
  assert.deepEqual(result.results.map((item) => item.path), ["/.env"]);
});
