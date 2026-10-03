import crypto from "node:crypto";
import axios from "axios";
import prisma from "../config/db.js";
import { encryptSecret, decryptSecret, decryptObjectValues } from "./secretService.js";
import { resourceNames, setTaskEgress } from "./ecsService.js";
import { getRepositoryName, getImageScanFindings } from "./ecrService.js";
import { ensureWebAcl, deleteWebAcl, syncTripwireBans, attackSummary, tripwirePathsFor, adminPathsFor } from "./wafService.js";
import { createCanary, checkCanary, deleteCanary, CANARY_ENV } from "./canaryService.js";
import { scanCodeSecurity, runSelfPentest, imageFindings, scoreFindings, extractRoutes, LOGIN_ROUTE, KEY_PATTERNS } from "./securityScanner.js";
import { firewallDecoys, robotsBait, appServesRobots, staticDecoyObjects, BAIT_PATHS, DECOY_FILES, newDoorToken } from "./deceptionService.js";
import { plantStaticDecoys, attachWebAclToDistribution } from "./staticDeployer.js";

export { extractRoutes };

/**
 * Security orchestration for a project.
 *  FREE      - code scan, self-pentest + score, image CVE scan, canary secret, security gate,
 *              leak watch, CVE/push alerts, attack-surface diff, blast radius, AI red team,
 *              decoy files on static sites, outbound firewall and read-only containers (opt-in).
 *  PROTECTED - FREE + AWS WAF with deception (decoys, honey credentials, robots.txt bait),
 *              tripwire auto-bans, shared attacker list, admin lockdown + rotating door, bot
 *              challenge, self-tuning rate limits, Under Attack mode, attack dashboard and replay.
 */

export const SECURITY_TIERS = {
  FREE: { label: "Free", monthlyCost: "$0" },
  PROTECTED: { label: "Protected", monthlyCost: "about $14-20/month (AWS WAF: $5 + $1 per rule) + $0.60 per million requests" },
};

/** Per-project feature switches. Every feature can be turned off; defaults favour protection without breaking apps. */
export const DEFAULT_SETTINGS = {
  autoResponse: true,
  deception: true,
  herdImmunity: true,
  botChallenge: "off",
  adminAllowIps: [],
  adminDoor: false,
  securityGate: "warn",
  egressLockdown: false,
  readOnlyRoot: false,
  selfTuningLimits: true,
  cveWatch: true,
  pushSecretWatch: true,
  leakWatch: true,
  leakAutoOffline: false,
  walletBudgetUsd: 0,
  walletHardStop: false,
  applyCodePermissions: false,
};

export function securitySettings(project) {
  return { ...DEFAULT_SETTINGS, ...(project?.protection?.settings || {}) };
}

const settingsError = (message) => Object.assign(new Error(message), { statusCode: 400 });

export function normalizeSecuritySettings(input = {}, current = DEFAULT_SETTINGS) {
  const next = { ...DEFAULT_SETTINGS, ...current };
  for (const key of ["autoResponse", "deception", "herdImmunity", "adminDoor", "egressLockdown", "readOnlyRoot", "selfTuningLimits", "cveWatch", "pushSecretWatch", "leakWatch", "leakAutoOffline", "walletHardStop", "applyCodePermissions"]) {
    if (key in input) next[key] = input[key] === true;
  }
  if ("botChallenge" in input) {
    if (!["off", "login", "all"].includes(input.botChallenge)) throw settingsError("Bot challenge must be off, login, or all.");
    next.botChallenge = input.botChallenge;
  }
  if ("securityGate" in input) {
    if (!["off", "warn", "block"].includes(input.securityGate)) throw settingsError("Security gate must be off, warn, or block.");
    next.securityGate = input.securityGate;
  }
  if ("adminAllowIps" in input) {
    const list = (Array.isArray(input.adminAllowIps) ? input.adminAllowIps : String(input.adminAllowIps || "").split(/[\s,]+/)).map((ip) => String(ip).trim()).filter(Boolean);
    for (const ip of list) {
      if (!/^\d{1,3}(\.\d{1,3}){3}(\/(3[0-2]|[12]?\d))?$/.test(ip) || ip.split("/")[0].split(".").some((part) => Number(part) > 255)) throw settingsError(`${ip} is not a valid IPv4 address or CIDR range.`);
    }
    if (list.length > 50) throw settingsError("At most 50 admin IP ranges are allowed.");
    next.adminAllowIps = [...new Set(list)];
  }
  if ("walletBudgetUsd" in input) {
    const value = Number(input.walletBudgetUsd || 0);
    if (!Number.isFinite(value) || value < 0 || value > 100000) throw settingsError("The monthly budget must be between 0 and 100000 USD (0 turns the guard off).");
    next.walletBudgetUsd = Math.round(value * 100) / 100;
  }
  return next;
}

export function ensureScanToken(protection) {
  return protection?.scanToken || crypto.randomBytes(24).toString("hex");
}

/** Merges a patch into the latest stored protection (never overwrites fields written concurrently). */
export async function patchProtection(projectId, patch) {
  const current = await prisma.project.findUnique({ where: { id: projectId }, select: { protection: true } });
  const next = { ...(current?.protection || {}), ...(typeof patch === "function" ? patch(current?.protection || {}) : patch) };
  await prisma.project.update({ where: { id: projectId }, data: { protection: next } });
  return next;
}

/** Returns the canary env vars for the container, creating the canary once per project. */
export async function prepareCanary({ project, credentials, log }) {
  const protection = project.protection || {};
  try {
    if (protection.canary?.accessKeyId && protection.canary?.secret) {
      return { env: { [CANARY_ENV.keyId]: protection.canary.accessKeyId, [CANARY_ENV.secret]: decryptSecret(protection.canary.secret) }, canary: protection.canary };
    }
    const created = await createCanary({ credentials, appName: resourceNames(project).appName });
    const canary = { userName: created.userName, accessKeyId: created.accessKeyId, secret: encryptSecret(created.secretAccessKey), createdAt: new Date().toISOString() };
    await patchProtection(project.id, (current) => ({ scanToken: ensureScanToken(current), canary }));
    log?.(`[SECURITY] Canary credential planted (IAM user ${created.userName}, no permissions). Any use of it means the container's secrets leaked.`);
    return { env: { [CANARY_ENV.keyId]: created.accessKeyId, [CANARY_ENV.secret]: created.secretAccessKey }, canary };
  } catch (error) {
    log?.(`[SECURITY] Canary credential skipped (${error.name || "error"}: ${String(error.message).slice(0, 120)}). Grant iam:CreateUser/CreateAccessKey to enable it.`, "warn");
    return { env: {}, canary: null };
  }
}

/** Honey credential for decoy files: an IAM user with no permissions, created once per project. */
export async function prepareHoney({ project, credentials, log }) {
  const fresh = await prisma.project.findUnique({ where: { id: project.id }, select: { protection: true } });
  const honey = fresh?.protection?.honey;
  if (honey?.accessKeyId && honey?.secret) return { ...honey, secretValue: decryptSecret(honey.secret) };
  try {
    const created = await createCanary({ credentials, appName: resourceNames(project).appName, purpose: "honey" });
    const record = { userName: created.userName, accessKeyId: created.accessKeyId, secret: encryptSecret(created.secretAccessKey), createdAt: new Date().toISOString() };
    await patchProtection(project.id, { honey: record });
    log?.(`[DECEPTION] Honey credential created (IAM user ${created.userName}, no permissions). It is planted in decoy files; any use of it identifies an attacker.`);
    return { ...record, secretValue: created.secretAccessKey };
  } catch (error) {
    log?.(`[DECEPTION] Honey credential skipped (${error.name || "error"}: ${String(error.message).slice(0, 120)}). Grant iam:CreateUser/CreateAccessKey to enable decoys.`, "warn");
    return null;
  }
}

const NO_FIREWALL = { webAclArn: null, webAclId: null, ipSetId: null, webAclName: null, ipSetName: null };
export const isStaticResources = (resources) => /^S3_/.test(resources?.type || "") || Boolean(resources?.bucket && !resources?.loadBalancerArn);

/**
 * Brings decoys and the firewall in line with the project's tier and settings for the given live
 * resources. Returns the resource keys to record on the deployment (so teardown deletes them).
 */
export async function applyProtection({ project: given, credentials, resources, sourceFiles = [], underAttack, log, target }) {
  const project = await prisma.project.findUnique({ where: { id: given.id } }) || given;
  const protection = project.protection || {};
  const settings = securitySettings(project);
  const appName = resourceNames(project).appName;
  const routes = sourceFiles.length ? extractRoutes(sourceFiles) : protection.waf?.routes || protection.routes || [];
  const builtRobots = (resources?.releaseFiles || []).some((file) => /(^|\/)robots\.txt$/i.test(String(file)));
  const appHasRobots = builtRobots || (sourceFiles.length ? appServesRobots(sourceFiles, routes) : Boolean(protection.appHasRobots));
  if (sourceFiles.length) await patchProtection(project.id, { routes: routes.slice(0, 300), appHasRobots });

  if (isStaticResources(resources) || target === "AWS_S3_CLOUDFRONT") {
    return applyStaticProtection({ project, credentials, resources, settings, appName, appHasRobots, log });
  }

  if (project.securityTier !== "PROTECTED") {
    if (protection.waf) {
      await deleteWebAcl({ credentials, appName, loadBalancerArn: resources?.loadBalancerArn, webAclId: protection.waf.webAclId, ipSetId: protection.waf.ipSetId });
      await patchProtection(project.id, { waf: null, bans: [] });
      log?.("[SECURITY] Protected tier off: firewall removed.");
    }
    return { ...NO_FIREWALL };
  }
  if (!resources?.loadBalancerArn) throw new Error("The site has no load balancer yet; deploy it first.");

  const honey = settings.deception ? await prepareHoney({ project, credentials, log }) : null;
  const decoys = honey ? firewallDecoys({ appName, honeyKeyId: honey.accessKeyId, honeySecret: honey.secretValue, servedRoutes: routes }) : null;
  const robots = settings.deception && !appHasRobots ? robotsBait() : null;
  let door = settings.adminDoor ? protection.door : null;
  if (settings.adminDoor && !door?.token) {
    door = { token: newDoorToken(), rotatedAt: new Date().toISOString() };
    await patchProtection(project.id, { door });
  }
  const scanToken = ensureScanToken(protection);
  const waf = await ensureWebAcl({
    credentials,
    appName,
    loadBalancerArn: resources.loadBalancerArn,
    scanToken,
    tripwirePaths: tripwirePathsFor({ framework: project.framework, sourceRoutes: routes, extra: settings.deception ? BAIT_PATHS : [] }),
    loginPaths: routes.filter((route) => LOGIN_ROUTE.test(route)).slice(0, 20),
    underAttack: underAttack ?? Boolean(protection.waf?.underAttack),
    forwardedIp: Boolean(resources.edgeDistributionId),
    limits: settings.selfTuningLimits ? protection.tuning?.limits || null : null,
    decoys,
    robots,
    adminPaths: adminPathsFor({ sourceRoutes: routes }),
    adminAllowIps: settings.adminAllowIps,
    doorToken: settings.adminDoor ? door?.token : null,
    botChallenge: settings.botChallenge,
  });
  await patchProtection(project.id, (current) => ({
    scanToken,
    waf: { ...waf, routes: routes.slice(0, 200), decoyKeys: (decoys || []).map((decoy) => decoy.key), autoUnderAttackUntil: underAttack === false ? null : current.waf?.autoUnderAttackUntil || null },
    bans: current.bans || [],
    ...(settings.adminDoor ? {} : { door: null }),
  }));
  const extras = [
    decoys?.length ? `${decoys.reduce((total, decoy) => total + decoy.paths.length, 0)} decoy files` : null,
    robots ? "robots.txt bait" : null,
    settings.adminAllowIps.length ? `admin locked to ${settings.adminAllowIps.length} IP range(s)` : null,
    settings.adminDoor ? "rotating admin door" : null,
    waf.botChallenge !== "off" ? `bot challenge (${waf.botChallenge})` : null,
  ].filter(Boolean);
  log?.(`[SECURITY] Firewall active: OWASP + IP reputation + known-bad-input rules, rate limits ${waf.limits.global}/${waf.limits.login} per 5 min${waf.underAttack ? " (UNDER ATTACK mode)" : ""}, ${waf.tripwirePaths.length} tripwires, ${waf.loginPaths.length} login route(s) from the source${extras.length ? `, ${extras.join(", ")}` : ""}.`);
  return {
    webAclArn: waf.webAclArn, webAclId: waf.webAclId, ipSetId: waf.ipSetId, webAclName: waf.webAclName, ipSetName: waf.ipSetName,
    honeyUserName: honey?.userName || null,
  };
}

async function applyStaticProtection({ project, credentials, resources, settings, appName, appHasRobots, log }) {
  const keys = { ...NO_FIREWALL, securityAppName: appName, honeyUserName: null, cloudfrontWebAclId: null, cloudfrontIpSetId: null };
  if (!resources?.bucket) return keys;
  if (settings.deception) {
    const honey = await prepareHoney({ project, credentials, log });
    if (honey) {
      const planted = await plantStaticDecoys({ credentials, resources, objects: staticDecoyObjects({ appName, honeyKeyId: honey.accessKeyId, honeySecret: honey.secretValue, hasRobots: appHasRobots }) })
        .catch((error) => {
          log?.(`[DECEPTION] Decoy files could not be uploaded: ${String(error.message).slice(0, 140)}`, "warn");
          return [];
        });
      if (planted.length) log?.(`[DECEPTION] Decoy files planted: ${planted.map((key) => `/${key}`).join(", ")} (they hold a honey key; any use of it raises an alert).`);
      keys.honeyUserName = honey.userName;
      await patchProtection(project.id, { staticDecoys: planted });
    }
  }
  const protection = (await prisma.project.findUnique({ where: { id: project.id }, select: { protection: true } }))?.protection || {};
  if (project.securityTier === "PROTECTED" && resources.distributionId) {
    const scanToken = ensureScanToken(protection);
    const waf = await ensureWebAcl({
      credentials, appName, scope: "CLOUDFRONT", scanToken,
      tripwirePaths: tripwirePathsFor({ framework: project.framework, extra: settings.deception ? BAIT_PATHS : [] }).filter((path) => !DECOY_FILES.some((file) => file.paths.includes(path))),
      loginPaths: [], underAttack: Boolean(protection.waf?.underAttack), limits: settings.selfTuningLimits ? protection.tuning?.limits || null : null,
      botChallenge: settings.botChallenge,
    });
    await attachWebAclToDistribution({ credentials, distributionId: resources.distributionId, webAclArn: waf.webAclArn });
    await patchProtection(project.id, { scanToken, waf: { ...waf, routes: [], decoyKeys: [] }, bans: protection.bans || [] });
    log?.(`[SECURITY] CloudFront firewall active: OWASP + IP reputation + known-bad-input rules, rate limits, ${waf.tripwirePaths.length} tripwires.`);
    return { ...keys, cloudfrontWebAclId: waf.webAclId, cloudfrontIpSetId: waf.ipSetId, webAclArn: waf.webAclArn };
  }
  if (protection.waf?.scope === "CLOUDFRONT") {
    if (resources.distributionId) await attachWebAclToDistribution({ credentials, distributionId: resources.distributionId, webAclArn: "" }).catch(() => {});
    await deleteWebAcl({ credentials, appName, scope: "CLOUDFRONT", webAclId: protection.waf.webAclId, ipSetId: protection.waf.ipSetId }).catch((error) => log?.(`[SECURITY] CloudFront firewall removal will finish on destroy: ${error.message}`, "warn"));
    await patchProtection(project.id, { waf: null, bans: [] });
  }
  if (project.securityTier === "PROTECTED") {
    log?.("[SECURITY] The Protected-tier firewall needs CloudFront in front of the bucket. S3 website hosting (used while CloudFront is unavailable on this AWS account) cannot have a firewall; decoys, leak watch, and scanning still apply.", "warn");
  }
  return keys;
}

/** Outbound firewall on the live tasks; takes effect immediately without a redeploy. */
export async function applyEgressFirewall({ project, credentials, resources, log }) {
  if (!resources?.taskSecurityGroupId) return null;
  const settings = securitySettings(project);
  const ports = settings.egressLockdown ? project.protection?.egressPorts || [80, 443] : null;
  await setTaskEgress({ credentials, resources, ports });
  if (ports) log?.(`[SECURITY] Outbound firewall on: TCP ${ports.join(", ")} only.`);
  return ports;
}

// ---------------------------------------------------------------- leak watch (#11)

const SECRET_NAME = /SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE|API_?KEY|ACCESS_?KEY|DATABASE_URL|DSN|CREDENTIAL|CONNECTION_STRING|_URI$/i;
const COMMON_VALUE = /^(true|false|null|none|production|development|staging|test|localhost|0\.0\.0\.0|\d{1,6}|https?:\/\/[^/]+\/?)$/i;

function secretValuesFor(project) {
  const values = decryptObjectValues(project.envConfig || {});
  const secrets = Object.entries(values)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === "string" && value.length >= 8 && !COMMON_VALUE.test(value))
    .map(([name, value]) => ({ name, value }));
  const canary = project.protection?.canary?.secret ? decryptSecret(project.protection.canary.secret) : null;
  if (canary) secrets.push({ name: "canary secret (AWS_BACKUP_SECRET_ACCESS_KEY)", value: canary });
  return secrets;
}

/**
 * Fetches the site's pages and same-origin scripts and looks for the project's real secret values,
 * provider key formats, and the canary key. Values are never logged; findings name the variable.
 */
export async function runLeakWatch({ project, liveUrl, scanToken, decoyMarkers = [] }) {
  if (!liveUrl) return { findings: [], checked: 0 };
  const base = new URL(liveUrl);
  const secrets = secretValuesFor(project);
  const get = async (target) => {
    try {
      const response = await axios.get(new URL(target, base).toString(), {
        timeout: 10_000, maxRedirects: 2, responseType: "text", transformResponse: (data) => data, maxContentLength: 3 * 1024 * 1024,
        validateStatus: () => true, headers: { "User-Agent": "SkyForge-LeakWatch/1.0", ...(scanToken ? { "x-skyforge-scan": scanToken } : {}) },
      });
      return { url: target, status: response.status, body: typeof response.data === "string" ? response.data : "" };
    } catch {
      return null;
    }
  };
  const pages = ["/", "/index.html", "/config.js", "/env.js", "/config.json", "/api/config", "/api/env", "/debug", "/env", "/settings.json", "/manifest.json"];
  const responses = [];
  const home = await get("/");
  if (home) responses.push(home);
  const scripts = [...new Set([...(home?.body || "").matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((match) => match[1]))]
    .filter((src) => {
      try {
        return new URL(src, base).host === base.host;
      } catch {
        return false;
      }
    })
    .slice(0, 15);
  for (const target of [...pages.slice(1), ...scripts]) {
    const response = await get(target);
    if (response && response.status < 400 && response.body) responses.push(response);
  }
  const findings = [];
  for (const response of responses) {
    if (decoyMarkers.some((marker) => marker && response.body.includes(marker))) continue;
    for (const secret of secrets) {
      if (response.body.includes(secret.value)) {
        findings.push({ id: `leak:value:${secret.name}:${response.url}`, source: "leak-watch", rule: "secret-value-in-response", severity: "critical", location: response.url, title: `The value of ${secret.name} is visible in ${response.url}`, detail: "Anyone visiting the site can read this secret (often a frontend build that inlined a server-side variable).", fix: `Rotate ${secret.name} now, then keep it server-side: only variables meant to be public should use VITE_/NEXT_PUBLIC_/REACT_APP_ prefixes.`, fixable: false });
      }
    }
    for (const pattern of KEY_PATTERNS) {
      pattern.regex.lastIndex = 0;
      const match = pattern.regex.exec(response.body);
      if (match) findings.push({ id: `leak:pattern:${pattern.rule}:${response.url}`, source: "leak-watch", rule: `${pattern.rule}-in-response`, severity: pattern.severity, location: response.url, title: `${pattern.title.replace(/ committed.*$/, "")} served publicly in ${response.url}`, detail: "A credential is part of a public response.", fix: "Revoke and rotate the credential, and remove it from the frontend build or response.", fixable: false });
    }
  }
  const seen = new Set();
  return { findings: findings.filter((item) => (seen.has(item.id) ? false : seen.add(item.id))), checked: responses.length };
}

/** Builds and stores the security report (code + live pentest + leak watch + image + canary + honey). */
export async function buildSecurityReport({ project, credentials, liveUrl, imageDigest, sourceFiles = [], log }) {
  const fresh = await prisma.project.findUnique({ where: { id: project.id } });
  const protection = fresh.protection || {};
  const settings = securitySettings(fresh);
  const scanToken = ensureScanToken(protection);
  if (!protection.scanToken) await patchProtection(project.id, { scanToken });
  const decoyMarkers = [protection.honey?.accessKeyId].filter(Boolean);

  const previous = fresh.securityReport || {};
  const codeFindings = sourceFiles.length ? scanCodeSecurity(sourceFiles) : (previous.findings || []).filter((item) => item.source === "code");
  const pentest = liveUrl ? await runSelfPentest(liveUrl, { scanToken, decoyMarkers }) : { findings: [] };
  const leaks = liveUrl && settings.leakWatch ? await runLeakWatch({ project: fresh, liveUrl, scanToken, decoyMarkers }) : { findings: (previous.findings || []).filter((item) => item.source === "leak-watch"), checked: 0 };

  let image = previous.image || null;
  if (credentials && imageDigest) {
    image = await getImageScanFindings({ credentials, repositoryName: getRepositoryName(project), imageDigest }).catch((error) => ({ status: "ERROR", detail: error.message }));
  }

  let canary = protection.canary ? { userName: protection.canary.userName, accessKeyId: protection.canary.accessKeyId, createdAt: protection.canary.createdAt } : null;
  const extra = [];
  if (credentials && canary) {
    const status = await checkCanary({ credentials, accessKeyId: canary.accessKeyId }).catch(() => null);
    if (status) canary = { ...canary, ...status, checkedAt: new Date().toISOString() };
    if (status?.used) extra.push({ id: "canary:used", source: "canary", rule: "canary-used", severity: "critical", title: "Canary credential was used — the container's secrets have leaked", detail: `Last used ${status.lastUsedAt}${status.service ? ` against ${status.service}` : ""}${status.region ? ` in ${status.region}` : ""}.`, fix: "Rotate every secret on the Environment page, redeploy, and investigate how the environment was exposed (debug pages, SSRF, leaked image)." });
  }
  const honeyUsed = protection.honeyStatus?.used;
  if (honeyUsed) extra.push({ id: "honey:used", source: "deception", rule: "honey-used", severity: "info", title: "An attacker took a decoy file and tried its credentials", detail: `The honey key from the decoy .env was used ${protection.honeyStatus.lastUsedAt}${protection.honeyStatus.region ? ` in ${protection.honeyStatus.region}` : ""}. Your real secrets were not in that file.`, fix: "No secrets leaked. Review the banned IPs; keep the Protected tier on." });

  const { score, grade, findings } = scoreFindings([...codeFindings, ...pentest.findings, ...leaks.findings, ...imageFindings(image), ...extra]);
  const report = {
    score, grade, findings,
    generatedAt: new Date().toISOString(),
    scannedUrl: pentest.scannedUrl || liveUrl || null,
    leakWatch: { checked: leaks.checked, at: new Date().toISOString() },
    image,
    canary,
    tier: fresh.securityTier,
  };
  await prisma.project.update({ where: { id: project.id }, data: { securityReport: report } });
  log?.(`[SECURITY] Security score ${score}/100 (grade ${grade}): ${findings.filter((item) => ["critical", "high"].includes(item.severity)).length} critical/high, ${findings.length} total finding(s).`);
  return report;
}

// ---------------------------------------------------------------- herd immunity (#12)

export async function recordThreats(projectId, bans) {
  for (const ban of bans) {
    await prisma.threatIntel.upsert({
      where: { ip: ban.ip },
      create: { ip: ban.ip, projectIds: [projectId], reasons: [ban.reason].filter(Boolean) },
      update: { hits: { increment: 1 }, lastSeen: new Date() },
    }).then(async (row) => {
      if (!row.projectIds.includes(projectId) || (ban.reason && !row.reasons.includes(ban.reason) && row.reasons.length < 10)) {
        await prisma.threatIntel.update({
          where: { ip: ban.ip },
          data: {
            projectIds: [...new Set([...row.projectIds, projectId])].slice(-50),
            reasons: [...new Set([...row.reasons, ban.reason].filter(Boolean))].slice(0, 10),
          },
        });
      }
    }).catch(() => {});
  }
}

/** Attacker IPs seen by other SkyForge projects in the last 7 days. */
export async function sharedThreatIps(projectId, { days = 7, limit = 3000 } = {}) {
  const rows = await prisma.threatIntel.findMany({
    where: { lastSeen: { gt: new Date(Date.now() - days * 86400_000) } },
    orderBy: { lastSeen: "desc" },
    take: limit * 2,
    select: { ip: true, projectIds: true },
  });
  return rows.filter((row) => row.projectIds.some((id) => id !== projectId)).slice(0, limit).map((row) => row.ip);
}

/**
 * Periodic upkeep from the monitor: bans (tripwires, decoys, shared list), canary and honey checks.
 * Runs at most every 10 minutes. Returns security events for the incident engine.
 */
export async function syncProjectSecurity({ projectId, credentials, force = false }) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  const protection = project?.protection || {};
  if (!project || (!force && Date.now() - Date.parse(protection.lastSyncAt || 0) < 10 * 60_000)) return null;
  const settings = securitySettings(project);
  const events = [];
  const patch = { lastSyncAt: new Date().toISOString() };
  if (project.securityTier === "PROTECTED" && protection.waf?.webAclArn) {
    // Unbanned IPs stay exempt for 24 hours so the same sampled tripwire hit does not re-ban them.
    const unbanned = (protection.unbanned || []).filter((entry) => Date.parse(entry.until) > Date.now());
    patch.unbanned = unbanned;
    const shared = settings.herdImmunity ? await sharedThreatIps(projectId).catch(() => []) : [];
    const result = await syncTripwireBans({
      credentials,
      appName: resourceNames(project).appName,
      webAclArn: protection.waf.webAclArn,
      ipSetId: protection.waf.ipSetId,
      bans: protection.bans || [],
      ignoreIps: unbanned.map((entry) => entry.ip),
      sharedIps: shared,
      decoyKeys: protection.waf.decoyKeys || [],
      scope: protection.waf.scope || "REGIONAL",
    }).catch(() => null);
    if (result) {
      patch.bans = result.bans;
      patch.sharedBanCount = result.sharedCount;
      if (result.newBans.length) {
        await recordThreats(projectId, result.newBans);
        const decoyTakers = result.newBans.filter((ban) => /decoy/.test(ban.reason));
        events.push({
          kind: decoyTakers.length ? "decoy.taken" : "ip.banned",
          severity: decoyTakers.length ? "medium" : "low",
          title: decoyTakers.length ? `${decoyTakers.length} attacker(s) downloaded a decoy secrets file and were banned` : `${result.newBans.length} scanner IP(s) hit a tripwire and were banned`,
          detail: { bans: result.newBans.slice(0, 20) },
          dedupeKey: `bans:${result.newBans.map((ban) => ban.ip).sort().join(",")}`.slice(0, 180),
        });
      }
    }
  }
  if (protection.canary?.accessKeyId) {
    const status = await checkCanary({ credentials, accessKeyId: protection.canary.accessKeyId }).catch(() => null);
    if (status) {
      patch.canaryStatus = { ...status, checkedAt: patch.lastSyncAt };
      if (status.used && status.lastUsedAt !== protection.canaryStatus?.lastUsedAt) {
        events.push({ kind: "canary.used", severity: "critical", title: "Canary key used: the container's secrets have leaked", detail: status, dedupeKey: `canary:${status.lastUsedAt}` });
      }
    }
  }
  if (protection.honey?.accessKeyId) {
    const status = await checkCanary({ credentials, accessKeyId: protection.honey.accessKeyId }).catch(() => null);
    if (status) {
      patch.honeyStatus = { ...status, checkedAt: patch.lastSyncAt };
      if (status.used && status.lastUsedAt !== protection.honeyStatus?.lastUsedAt) {
        events.push({ kind: "honey.used", severity: "high", title: "An attacker is trying the credentials from a decoy file", detail: status, dedupeKey: `honey:${status.lastUsedAt}` });
      }
    }
  }
  const next = await patchProtection(projectId, patch);
  return { protection: next, events };
}

export async function firewallSummary({ project, credentials, hours = 3 }) {
  const waf = project.protection?.waf;
  if (project.securityTier !== "PROTECTED" || !waf?.webAclArn || !credentials) return null;
  return attackSummary({ credentials, appName: resourceNames(project).appName, webAclArn: waf.webAclArn, decoyKeys: waf.decoyKeys || [], scope: waf.scope || "REGIONAL", hours });
}

export async function removeCanary({ project, credentials }) {
  if (!project.protection?.canary) return;
  await deleteCanary({ credentials, appName: resourceNames(project).appName, userName: project.protection.canary.userName });
}
