import crypto from "node:crypto";
import prisma from "../config/db.js";
import { encryptSecret, decryptSecret } from "./secretService.js";
import { resourceNames } from "./ecsService.js";
import { getRepositoryName, getImageScanFindings } from "./ecrService.js";
import { ensureWebAcl, deleteWebAcl, syncTripwireBans, attackSummary, tripwirePathsFor } from "./wafService.js";
import { createCanary, checkCanary, deleteCanary, CANARY_ENV } from "./canaryService.js";
import { scanCodeSecurity, runSelfPentest, imageFindings, scoreFindings, extractRoutes, LOGIN_ROUTE } from "./securityScanner.js";

export { extractRoutes };

/**
 * Security orchestration for a project.
 *  FREE      - code scan, self-pentest + score, image CVE scan, canary secret, ALB header hardening,
 *              security headers on SkyForge-served static sites, AI fix pull requests.
 *  PROTECTED - FREE + AWS WAF (OWASP/IP-reputation/known-bad rules, rate limits, code-aware login
 *              limits, tripwire auto-ban, Under Attack mode, attack dashboard).
 */

export const SECURITY_TIERS = {
  FREE: { label: "Free", monthlyCost: "$0" },
  PROTECTED: { label: "Protected", monthlyCost: "about $14/month (AWS WAF: $5 + 9 rules) + $0.60 per million requests" },
};

export function ensureScanToken(protection) {
  return protection?.scanToken || crypto.randomBytes(24).toString("hex");
}

async function saveProtection(projectId, protection) {
  await prisma.project.update({ where: { id: projectId }, data: { protection } });
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
    await saveProtection(project.id, { ...protection, scanToken: ensureScanToken(protection), canary });
    log?.(`[SECURITY] Canary credential planted (IAM user ${created.userName}, no permissions). Any use of it means the container's secrets leaked.`);
    return { env: { [CANARY_ENV.keyId]: created.accessKeyId, [CANARY_ENV.secret]: created.secretAccessKey }, canary };
  } catch (error) {
    log?.(`[SECURITY] Canary credential skipped (${error.name || "error"}: ${String(error.message).slice(0, 120)}). Grant iam:CreateUser/CreateAccessKey to enable it.`, "warn");
    return { env: {}, canary: null };
  }
}

/**
 * Brings the firewall in line with the project's tier for the given live resources.
 * Returns the resource keys to record on the deployment (so teardown deletes them).
 */
export async function applyProtection({ project, credentials, resources, sourceFiles = [], underAttack, log }) {
  const protection = project.protection || {};
  const appName = resourceNames(project).appName;
  if (project.securityTier !== "PROTECTED") {
    if (protection.waf) {
      await deleteWebAcl({ credentials, appName, loadBalancerArn: resources?.loadBalancerArn, webAclId: protection.waf.webAclId, ipSetId: protection.waf.ipSetId });
      await saveProtection(project.id, { ...protection, waf: null, bans: [] });
      log?.("[SECURITY] Protected tier off: firewall removed.");
    }
    return { webAclArn: null, webAclId: null, ipSetId: null, webAclName: null, ipSetName: null };
  }
  if (!resources?.loadBalancerArn) throw new Error("The site has no load balancer yet; deploy it first.");
  const routes = sourceFiles.length ? extractRoutes(sourceFiles) : protection.waf?.routes || [];
  const scanToken = ensureScanToken(protection);
  const waf = await ensureWebAcl({
    credentials,
    appName,
    loadBalancerArn: resources.loadBalancerArn,
    scanToken,
    tripwirePaths: tripwirePathsFor({ framework: project.framework, sourceRoutes: routes }),
    loginPaths: routes.filter((route) => LOGIN_ROUTE.test(route)).slice(0, 20),
    underAttack: underAttack ?? Boolean(protection.waf?.underAttack),
  });
  await saveProtection(project.id, { ...protection, scanToken, waf: { ...waf, routes: routes.slice(0, 200) }, bans: protection.bans || [] });
  log?.(`[SECURITY] Firewall active: OWASP + IP reputation + known-bad-input rules, rate limits${waf.underAttack ? " (UNDER ATTACK mode)" : ""}, ${waf.tripwirePaths.length} tripwires, ${waf.loginPaths.length} login route(s) found in the source.`);
  return { webAclArn: waf.webAclArn, webAclId: waf.webAclId, ipSetId: waf.ipSetId, webAclName: waf.webAclName, ipSetName: waf.ipSetName };
}

/** Builds and stores the security report (code + live pentest + image + canary + firewall). */
export async function buildSecurityReport({ project, credentials, liveUrl, imageDigest, sourceFiles = [], log }) {
  const fresh = await prisma.project.findUnique({ where: { id: project.id } });
  const protection = fresh.protection || {};
  const scanToken = ensureScanToken(protection);
  if (!protection.scanToken) await saveProtection(project.id, { ...protection, scanToken });

  const previous = fresh.securityReport || {};
  const codeFindings = sourceFiles.length ? scanCodeSecurity(sourceFiles) : (previous.findings || []).filter((item) => item.source === "code");
  const pentest = liveUrl ? await runSelfPentest(liveUrl, { scanToken }) : { findings: [] };

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

  const { score, grade, findings } = scoreFindings([...codeFindings, ...pentest.findings, ...imageFindings(image), ...extra]);
  const report = {
    score, grade, findings,
    generatedAt: new Date().toISOString(),
    scannedUrl: pentest.scannedUrl || liveUrl || null,
    image,
    canary,
    tier: fresh.securityTier,
  };
  await prisma.project.update({ where: { id: project.id }, data: { securityReport: report } });
  log?.(`[SECURITY] Security score ${score}/100 (grade ${grade}): ${findings.filter((item) => ["critical", "high"].includes(item.severity)).length} critical/high, ${findings.length} total finding(s).`);
  return report;
}

/** Periodic upkeep from the monitor: tripwire bans and canary checks (at most every 10 minutes). */
export async function syncProjectSecurity({ projectId, credentials, force = false }) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  const protection = project?.protection || {};
  if (!project || (!force && Date.now() - Date.parse(protection.lastSyncAt || 0) < 10 * 60_000)) return null;
  const next = { ...protection, lastSyncAt: new Date().toISOString() };
  if (project.securityTier === "PROTECTED" && protection.waf?.webAclArn) {
    // Unbanned IPs stay exempt for 24 hours so the same sampled tripwire hit does not re-ban them.
    next.unbanned = (protection.unbanned || []).filter((entry) => Date.parse(entry.until) > Date.now());
    next.bans = await syncTripwireBans({
      credentials,
      appName: resourceNames(project).appName,
      webAclArn: protection.waf.webAclArn,
      ipSetId: protection.waf.ipSetId,
      bans: protection.bans || [],
      ignoreIps: next.unbanned.map((entry) => entry.ip),
    }).catch(() => protection.bans || []);
  }
  if (protection.canary?.accessKeyId) {
    const status = await checkCanary({ credentials, accessKeyId: protection.canary.accessKeyId }).catch(() => null);
    if (status) next.canaryStatus = { ...status, checkedAt: next.lastSyncAt };
  }
  await saveProtection(projectId, next);
  return next;
}

export async function firewallSummary({ project, credentials }) {
  const waf = project.protection?.waf;
  if (project.securityTier !== "PROTECTED" || !waf?.webAclArn || !credentials) return null;
  return attackSummary({ credentials, appName: resourceNames(project).appName, webAclArn: waf.webAclArn });
}

export async function removeCanary({ project, credentials }) {
  if (!project.protection?.canary) return;
  await deleteCanary({ credentials, appName: resourceNames(project).appName, userName: project.protection.canary.userName });
}
