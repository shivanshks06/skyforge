import prisma from "../config/db.js";
import { requireOwnedProject } from "../services/ownershipService.js";
import { assertProjectHasNoActiveOperation } from "../services/operationGuard.js";
import { getAwsCredentials } from "../services/awsConnectionService.js";
import { decryptSecret } from "../services/secretService.js";
import { fetchGitHubSourceFiles } from "../services/envScanner.js";
import { takeSiteOffline, startSiteTasks, describeTaskRolePermissions, resourceNames } from "../services/ecsService.js";
import { takeStaticSiteOffline, bringStaticSiteOnline } from "../services/staticDeployer.js";
import {
  SECURITY_TIERS, DEFAULT_SETTINGS, applyProtection, applyEgressFirewall, buildSecurityReport, ensureScanToken, firewallSummary,
  isStaticResources, normalizeSecuritySettings, patchProtection, securitySettings, syncProjectSecurity,
} from "../services/securityService.js";
import { runSecurityAutomation, estimateCost, setUnderAttackMode } from "../services/securityAutomation.js";
import { syncCodePermissions } from "../services/deploySecurity.js";
import { listIncidents, raiseIncident } from "../services/incidentService.js";
import { replayBlockedAttacks, runRedTeam, blastRadius } from "../services/redTeamService.js";
import { DOOR_PREFIX } from "../services/wafService.js";
import { createFixPullRequest } from "../services/fixPullRequest.js";
import { addMonitorJob } from "../queues/monitorQueue.js";

async function credentialsFor(project) {
  const connection = await prisma.awsConnection.findUnique({ where: { userId: project.userId } });
  return connection ? getAwsCredentials(connection) : null;
}

async function liveDeployment(projectId) {
  const deployments = await prisma.deployment.findMany({
    where: { projectId, status: { in: ["LIVE", "ROLLED_BACK"] } },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, liveUrl: true, resources: true },
  });
  return deployments.find((deployment) => deployment.resources?.loadBalancerArn || deployment.resources?.bucket) || null;
}

async function githubToken(userId) {
  const account = await prisma.gitHubAccount.findUnique({ where: { userId } });
  return account ? decryptSecret(account.accessToken) : null;
}

/** Records firewall/decoy resource keys on the live deployment so teardown always knows about them. */
async function recordKeys(live, keys) {
  const resources = { ...live.resources, ...keys };
  for (const key of Object.keys(keys)) if (!keys[key]) delete resources[key];
  await prisma.deployment.update({ where: { id: live.id }, data: { resources } });
}

function publicProtection(project, live) {
  const protection = project.protection || {};
  const settings = securitySettings(project);
  const door = settings.adminDoor && protection.door?.token && live?.liveUrl ? `${String(live.liveUrl).replace(/\/$/, "")}${DOOR_PREFIX}${protection.door.token}` : null;
  return {
    settings,
    firewall: protection.waf ? {
      active: true,
      scope: protection.waf.scope || "REGIONAL",
      underAttack: Boolean(protection.waf.underAttack),
      autoUnderAttackUntil: protection.waf.autoUnderAttackUntil || null,
      tripwirePaths: protection.waf.tripwirePaths || [],
      loginPaths: protection.waf.loginPaths || [],
      decoyPaths: protection.waf.decoyPaths || [],
      robots: Boolean(protection.waf.robots),
      adminPaths: protection.waf.adminPaths || [],
      botChallenge: protection.waf.botChallenge || "off",
      limits: protection.waf.limits || null,
      ruleCount: protection.waf.ruleCount || null,
    } : { active: false },
    bans: (protection.bans || []).filter((ban) => Date.parse(ban.until) > Date.now()),
    sharedBanCount: protection.sharedBanCount || 0,
    canary: protection.canary ? { userName: protection.canary.userName, accessKeyId: protection.canary.accessKeyId, createdAt: protection.canary.createdAt, status: protection.canaryStatus || null } : null,
    honey: protection.honey ? { userName: protection.honey.userName, accessKeyId: protection.honey.accessKeyId, createdAt: protection.honey.createdAt, status: protection.honeyStatus || null } : null,
    staticDecoys: protection.staticDecoys || [],
    door: door ? { url: door, rotatedAt: protection.door.rotatedAt } : null,
    tuning: protection.tuning || null,
    wallet: protection.wallet || null,
    leakWatch: protection.leakWatch || null,
    cve: protection.cve || null,
    pushWatch: protection.pushWatch || null,
    egressPorts: protection.egressPorts || null,
    codePermissions: protection.codePermissions || null,
    surface: protection.surface ? { routes: protection.surface.routes?.length || 0, adminRoutes: protection.surface.adminRoutes, loginRoutes: protection.surface.loginRoutes, debugRoutes: protection.surface.debugRoutes, uploadRoutes: protection.surface.uploadRoutes, dependencies: protection.surface.dependencies?.length || 0, capturedAt: protection.surface.capturedAt } : null,
    surfaceDiff: protection.surfaceDiff || null,
    surfaceHistory: protection.surfaceHistory || [],
    redTeam: protection.redTeam || null,
    replay: protection.replay || null,
    health: protection.health || null,
    resuming: Boolean(protection.resuming),
  };
}

const fail = (res, error, fallback) => {
  console.error(`[SECURITY] ${fallback}:`, error.message);
  const status = error.statusCode || (error.$metadata?.httpStatusCode === 403 || /AccessDenied|not authorized/i.test(error.message) ? 403 : 500);
  const message = status === 403 && !error.statusCode
    ? `AWS denied the request (${error.name || "AccessDenied"}). Your AWS credentials need permission for this feature.`
    : error.statusCode || error.expose ? error.message : `${fallback}: ${String(error.message).slice(0, 200)}`;
  return res.status(status).json({ message });
};

export const getSecurity = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    const live = await liveDeployment(project.id);
    let firewall = null;
    if (live && project.securityTier === "PROTECTED" && project.protection?.waf) {
      firewall = await firewallSummary({ project, credentials: await credentialsFor(project) }).catch(() => null);
    }
    const [incidents, openIncidents] = await Promise.all([
      listIncidents(project.id, { limit: 30 }),
      prisma.securityEvent.count({ where: { projectId: project.id, resolvedAt: null, severity: { in: ["critical", "high"] } } }),
    ]);
    const user = await prisma.user.findUnique({ where: { id: project.userId }, select: { alertSettings: true } });
    const channels = ["email", "slack", "discord", "telegram", "webhook"].filter((channel) => user?.alertSettings?.[channel]?.enabled);
    return res.json({
      tier: project.securityTier,
      tiers: SECURITY_TIERS,
      defaults: DEFAULT_SETTINGS,
      report: project.securityReport || null,
      protection: publicProtection(project, live),
      firewall,
      incidents,
      openIncidents,
      alertChannels: channels,
      target: project.deploymentTarget,
      site: { live: Boolean(live), offline: project.siteOffline, url: live?.liveUrl || null, static: isStaticResources(live?.resources), cloudfront: Boolean(live?.resources?.distributionId || live?.resources?.edgeDistributionId) },
    });
  } catch (error) {
    return fail(res, error, "Failed to load security status");
  }
};

export const setSecurityTier = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    await assertProjectHasNoActiveOperation(project.id);
    const tier = String(req.body?.tier || "").toUpperCase();
    if (!SECURITY_TIERS[tier]) return res.status(400).json({ message: "Tier must be FREE or PROTECTED." });
    const updated = await prisma.project.update({ where: { id: project.id }, data: { securityTier: tier } });
    const live = await liveDeployment(project.id);
    if (live) {
      const credentials = await credentialsFor(project);
      await recordKeys(live, await applyProtection({ project: updated, credentials, resources: live.resources, target: project.deploymentTarget }));
    }
    return res.json({ message: live ? `${SECURITY_TIERS[tier].label} tier applied to the live site.` : `${SECURITY_TIERS[tier].label} tier will apply on the next deployment.`, tier });
  } catch (error) {
    return fail(res, error, "Failed to change the security tier");
  }
};

const FIREWALL_KEYS = ["deception", "botChallenge", "adminAllowIps", "adminDoor", "selfTuningLimits", "herdImmunity"];

export const updateSecuritySettings = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    await assertProjectHasNoActiveOperation(project.id);
    const before = securitySettings(project);
    const settings = normalizeSecuritySettings(req.body?.settings || {}, before);
    await patchProtection(project.id, { settings });
    const changed = Object.keys(settings).filter((key) => JSON.stringify(settings[key]) !== JSON.stringify(before[key]));
    const live = await liveDeployment(project.id);
    const notes = [];
    if (live && changed.length) {
      const credentials = await credentialsFor(project);
      const fresh = await prisma.project.findUnique({ where: { id: project.id } });
      if (changed.some((key) => FIREWALL_KEYS.includes(key)) && (fresh.securityTier === "PROTECTED" || isStaticResources(live.resources))) {
        await recordKeys(live, await applyProtection({ project: fresh, credentials, resources: live.resources, target: fresh.deploymentTarget }));
        notes.push("firewall and decoys updated on the live site");
      }
      if (changed.includes("egressLockdown") && live.resources?.taskSecurityGroupId) {
        await applyEgressFirewall({ project: fresh, credentials, resources: live.resources });
        notes.push(`outbound firewall ${settings.egressLockdown ? "on" : "off"} (immediately)`);
      }
      if (changed.includes("applyCodePermissions") && live.resources?.taskRoleArn) {
        await syncCodePermissions({ project: fresh, credentials, analysis: { permissions: fresh.protection?.codePermissions || {} }, deploymentId: live.id });
        notes.push(settings.applyCodePermissions ? "task role now limited to the actions your code uses" : "code-derived task role policy removed");
      }
      if (changed.includes("readOnlyRoot")) notes.push("read-only filesystem applies on the next deployment");
    }
    return res.json({ message: `Security settings saved${notes.length ? `: ${notes.join("; ")}` : ""}.`, settings });
  } catch (error) {
    return fail(res, error, "Failed to save security settings");
  }
};

export const setUnderAttack = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    if (project.securityTier !== "PROTECTED") return res.status(400).json({ message: "Under Attack mode needs the Protected tier." });
    const live = await liveDeployment(project.id);
    if (!live) return res.status(409).json({ message: "The site is not live." });
    if (!project.protection?.waf) return res.status(409).json({ message: "The firewall is not active on this site." });
    await setUnderAttackMode({ project, credentials: await credentialsFor(project), resources: live.resources, enabled: req.body?.enabled === true });
    return res.json({ message: req.body?.enabled === true ? "Under Attack mode on: rate limits tightened (300 requests per 5 min per IP, 20 on login routes) and page loads get a bot challenge." : "Under Attack mode off: normal limits restored." });
  } catch (error) {
    return fail(res, error, "Failed to change Under Attack mode");
  }
};

export const unbanIp = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    const ip = String(req.body?.ip || "");
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return res.status(400).json({ message: "A valid IPv4 address is required." });
    await patchProtection(project.id, (protection) => ({
      bans: (protection.bans || []).filter((ban) => ban.ip !== ip),
      unbanned: [...(protection.unbanned || []), { ip, until: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }],
      lastSyncAt: null,
    }));
    await prisma.threatIntel.delete({ where: { ip } }).catch(() => {});
    const credentials = await credentialsFor(project);
    if (credentials) await syncProjectSecurity({ projectId: project.id, credentials, force: true });
    return res.json({ message: `${ip} unbanned (exempt from automatic bans for 24 hours and removed from the shared attacker list).` });
  } catch (error) {
    return fail(res, error, "Failed to unban the IP");
  }
};

export const runSecurityScan = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    const [owner, repo] = String(project.repoName).split("/");
    const token = await githubToken(project.userId);
    const sourceFiles = await fetchGitHubSourceFiles({ owner, repo, ref: project.branch, token })
      .catch(() => fetchGitHubSourceFiles({ owner, repo, ref: null, token }))
      .catch(() => null) || [];
    const live = await liveDeployment(project.id);
    const credentials = await credentialsFor(project).catch(() => null);
    const report = await buildSecurityReport({
      project,
      credentials,
      liveUrl: project.siteOffline ? null : live?.liveUrl,
      imageDigest: live?.resources?.imageDigest,
      sourceFiles,
    });
    return res.json({ report });
  } catch (error) {
    return fail(res, error, "Security scan failed");
  }
};

export const createSecurityFix = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    const report = project.securityReport || {};
    const finding = (report.findings || []).find((item) => item.id === req.body?.findingId);
    if (!finding) return res.status(404).json({ message: "Finding not found; run a new scan." });
    const result = await createFixPullRequest({ token: await githubToken(project.userId), repoName: project.repoName, branch: project.branch, finding });
    await prisma.project.update({
      where: { id: project.id },
      data: { securityReport: { ...report, findings: report.findings.map((item) => (item.id === finding.id ? { ...item, fixUrl: result.url, fixKind: result.kind } : item)) } },
    });
    return res.json(result);
  } catch (error) {
    const status = error.response?.status;
    if (status === 403 || status === 404) return res.status(400).json({ message: "GitHub refused the change. Reconnect GitHub with repository access and try again." });
    return fail(res, error, "Could not create the fix");
  }
};

export const getIncidents = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    return res.json({ incidents: await listIncidents(project.id, { limit: 100 }) });
  } catch (error) {
    return fail(res, error, "Failed to load incidents");
  }
};

export const resolveIncident = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    const updated = await prisma.securityEvent.updateMany({ where: { id: String(req.params.incidentId), projectId: project.id }, data: { resolvedAt: new Date() } });
    if (!updated.count) return res.status(404).json({ message: "Incident not found." });
    return res.json({ message: "Incident marked as resolved." });
  } catch (error) {
    return fail(res, error, "Failed to resolve the incident");
  }
};

const CHECKS = ["sync", "attack", "push", "wallet", "tuning", "leaks", "cve"];

/** Runs the scheduled security checks immediately (bans, attack spikes, pushes, cost, tuning, leaks, CVEs). */
export const runChecksNow = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    const live = await liveDeployment(project.id);
    if (!live) return res.status(409).json({ message: "The site is not live." });
    const only = Array.isArray(req.body?.checks) ? req.body.checks.filter((check) => CHECKS.includes(check)) : CHECKS;
    await patchProtection(project.id, { lastSyncAt: null });
    const results = await runSecurityAutomation({ projectId: project.id, credentials: await credentialsFor(project), resources: live.resources, liveUrl: live.liveUrl, deploymentId: live.id, only });
    return res.json({ message: `Checks finished: ${Object.entries(results).map(([name, result]) => `${name} ${result === "ok" ? "✓" : result}`).join(", ")}.`, results });
  } catch (error) {
    return fail(res, error, "Security checks failed");
  }
};

export const rotateAdminDoor = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    if (!securitySettings(project).adminDoor || project.securityTier !== "PROTECTED") return res.status(400).json({ message: "Turn on the rotating admin door (Protected tier) first." });
    const live = await liveDeployment(project.id);
    if (!live) return res.status(409).json({ message: "The site is not live." });
    await runSecurityAutomation({ projectId: project.id, credentials: await credentialsFor(project), resources: live.resources, liveUrl: live.liveUrl, deploymentId: live.id, only: ["door"] });
    return res.json({ message: "Admin door rotated; the new link was sent to your alert channels and is shown on this page." });
  } catch (error) {
    return fail(res, error, "Failed to rotate the admin door");
  }
};

export const replayAttacks = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    const live = await liveDeployment(project.id);
    if (!live || project.siteOffline) return res.status(409).json({ message: "The site must be live and online." });
    const summary = project.securityTier === "PROTECTED" ? await firewallSummary({ project, credentials: await credentialsFor(project) }).catch(() => null) : null;
    const result = await replayBlockedAttacks({ liveUrl: live.liveUrl, scanToken: ensureScanToken(project.protection), blocked: summary?.recent || [], decoyMarkers: [project.protection?.honey?.accessKeyId].filter(Boolean) });
    await patchProtection(project.id, { replay: { ...result, at: new Date().toISOString() } });
    return res.json({ ...result, message: result.note || `Replayed ${result.replayed} blocked attack path(s) with the firewall bypassed: ${result.vulnerable.length ? `${result.vulnerable.length} would have succeeded without the firewall` : "the app itself handled all of them safely"}.` });
  } catch (error) {
    return fail(res, error, "Attack replay failed");
  }
};

export const runRedTeamRehearsal = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    const live = await liveDeployment(project.id);
    if (!live || project.siteOffline) return res.status(409).json({ message: "The site must be live and online." });
    const routes = project.protection?.surface?.routes || project.protection?.routes || [];
    const result = await runRedTeam({ liveUrl: live.liveUrl, scanToken: ensureScanToken(project.protection), routes, framework: project.framework });
    await patchProtection(project.id, { redTeam: result });
    if (result.findings.length) {
      await raiseIncident({
        projectId: project.id, kind: "redteam.findings", severity: result.findings.some((item) => item.severity === "high") ? "high" : "medium",
        title: `AI red team found ${result.findings.length} weakness(es)`, detail: { findings: result.findings }, dedupeKey: `redteam:${result.at}`,
      }).catch(() => {});
    }
    return res.json({ ...result, message: `Red-team rehearsal finished: ${result.requests} safe request(s), ${result.findings.length} finding(s).` });
  } catch (error) {
    return fail(res, error, "Red-team rehearsal failed");
  }
};

export const getBlastRadius = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    const live = await liveDeployment(project.id);
    let taskRole = null;
    if (live?.resources?.taskRoleArn) {
      taskRole = await describeTaskRolePermissions({ credentials: await credentialsFor(project), roleName: resourceNames(project).taskRoleName }).catch(() => null);
    }
    const settings = securitySettings(project);
    return res.json(blastRadius({ project, resources: live?.resources, taskRole, egressPorts: project.protection?.egressPorts, egressLockdown: settings.egressLockdown && Boolean(live?.resources?.taskSecurityGroupId) }));
  } catch (error) {
    return fail(res, error, "Failed to build the blast-radius map");
  }
};

export const getCostEstimate = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    const live = await liveDeployment(project.id);
    if (!live) return res.status(409).json({ message: "The site is not live." });
    const cost = await estimateCost({ project, credentials: await credentialsFor(project), resources: live.resources });
    await patchProtection(project.id, { wallet: cost });
    return res.json(cost);
  } catch (error) {
    return fail(res, error, "Failed to estimate costs");
  }
};

export const takeOffline = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    await assertProjectHasNoActiveOperation(project.id);
    const live = await liveDeployment(project.id);
    if (!live) return res.status(409).json({ message: "The site is not live." });
    if (project.siteOffline) return res.json({ message: "The site is already offline." });
    const credentials = await credentialsFor(project);
    if (isStaticResources(live.resources)) {
      await takeStaticSiteOffline({ credentials, resources: live.resources });
      await prisma.project.update({ where: { id: project.id }, data: { siteOffline: true, status: "Offline" } });
      return res.json({ message: live.resources.type === "S3_CLOUDFRONT" ? "The site will show a maintenance page within a few minutes (CloudFront propagation). Static hosting costs almost nothing while offline." : "The site now shows a maintenance page. Static hosting costs almost nothing while offline." });
    }
    await takeSiteOffline({ credentials, resources: live.resources });
    await patchProtection(project.id, { resuming: false });
    await prisma.project.update({ where: { id: project.id }, data: { siteOffline: true, status: "Offline" } });
    return res.json({ message: "The site now shows a maintenance page and the container is stopped. The load balancer still bills (about $0.55/day); destroy the project to stop all charges." });
  } catch (error) {
    return fail(res, error, "Failed to take the site offline");
  }
};

export const bringOnline = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    await assertProjectHasNoActiveOperation(project.id);
    const live = await liveDeployment(project.id);
    if (!live) return res.status(409).json({ message: "The site is not live; deploy it instead." });
    if (!project.siteOffline) return res.json({ message: "The site is already online." });
    if (isStaticResources(live.resources)) {
      await bringStaticSiteOnline({ credentials: await credentialsFor(project), resources: live.resources });
      await prisma.project.update({ where: { id: project.id }, data: { siteOffline: false, status: "Live" } });
      return res.json({ message: live.resources.type === "S3_CLOUDFRONT" ? "The site is restored; CloudFront propagates the change within a few minutes." : "The site is back online." });
    }
    await startSiteTasks({ credentials: await credentialsFor(project), resources: live.resources });
    await patchProtection(project.id, { resuming: true });
    await prisma.project.update({ where: { id: project.id }, data: { siteOffline: false, status: "Starting" } });
    // The monitor finishes the switch back once the container is healthy; make sure it is running.
    await addMonitorJob({ deploymentId: live.id, liveUrl: live.liveUrl, target: "ECS_FARGATE" }, { delay: 15_000, jobId: `monitor-${live.id}-resume-${Date.now()}` }).catch(() => {});
    return res.json({ message: "Starting the container. The maintenance page stays up until the app is healthy (usually 1-3 minutes)." });
  } catch (error) {
    return fail(res, error, "Failed to bring the site online");
  }
};
