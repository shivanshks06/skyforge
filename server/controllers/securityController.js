import prisma from "../config/db.js";
import { requireOwnedProject } from "../services/ownershipService.js";
import { assertProjectHasNoActiveOperation } from "../services/operationGuard.js";
import { getAwsCredentials } from "../services/awsConnectionService.js";
import { decryptSecret } from "../services/secretService.js";
import { fetchGitHubSourceFiles } from "../services/envScanner.js";
import { takeSiteOffline, startSiteTasks } from "../services/ecsService.js";
import { SECURITY_TIERS, applyProtection, buildSecurityReport, firewallSummary, syncProjectSecurity } from "../services/securityService.js";
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
  return deployments.find((deployment) => deployment.resources?.loadBalancerArn) || null;
}

async function githubToken(userId) {
  const account = await prisma.gitHubAccount.findUnique({ where: { userId } });
  return account ? decryptSecret(account.accessToken) : null;
}

function publicProtection(project) {
  const protection = project.protection || {};
  return {
    firewall: protection.waf ? {
      active: true,
      underAttack: Boolean(protection.waf.underAttack),
      tripwirePaths: protection.waf.tripwirePaths || [],
      loginPaths: protection.waf.loginPaths || [],
    } : { active: false },
    bans: (protection.bans || []).filter((ban) => Date.parse(ban.until) > Date.now()),
    canary: protection.canary ? { userName: protection.canary.userName, accessKeyId: protection.canary.accessKeyId, createdAt: protection.canary.createdAt, status: protection.canaryStatus || null } : null,
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
    if (live && project.securityTier === "PROTECTED") {
      firewall = await firewallSummary({ project, credentials: await credentialsFor(project) }).catch(() => null);
    }
    return res.json({
      tier: project.securityTier,
      tiers: SECURITY_TIERS,
      report: project.securityReport || null,
      protection: publicProtection(project),
      firewall,
      site: { live: Boolean(live), offline: project.siteOffline, url: live?.liveUrl || null },
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
      const keys = await applyProtection({ project: updated, credentials, resources: live.resources });
      // Record (or clear) the firewall on the live deployment so teardown always knows about it.
      const resources = { ...live.resources, ...keys };
      for (const key of Object.keys(keys)) if (!keys[key]) delete resources[key];
      await prisma.deployment.update({ where: { id: live.id }, data: { resources } });
    }
    return res.json({ message: live ? `${SECURITY_TIERS[tier].label} tier applied to the live site.` : `${SECURITY_TIERS[tier].label} tier will apply on the next deployment.`, tier });
  } catch (error) {
    return fail(res, error, "Failed to change the security tier");
  }
};

export const setUnderAttack = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    if (project.securityTier !== "PROTECTED") return res.status(400).json({ message: "Under Attack mode needs the Protected tier." });
    const live = await liveDeployment(project.id);
    if (!live) return res.status(409).json({ message: "The site is not live." });
    await applyProtection({ project, credentials: await credentialsFor(project), resources: live.resources, underAttack: req.body?.enabled === true });
    return res.json({ message: req.body?.enabled === true ? "Under Attack mode on: rate limits tightened (300 requests per 5 min per IP, 20 on login routes)." : "Under Attack mode off: normal limits restored." });
  } catch (error) {
    return fail(res, error, "Failed to change Under Attack mode");
  }
};

export const unbanIp = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    const ip = String(req.body?.ip || "");
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return res.status(400).json({ message: "A valid IPv4 address is required." });
    const protection = project.protection || {};
    await prisma.project.update({
      where: { id: project.id },
      data: {
        protection: {
          ...protection,
          bans: (protection.bans || []).filter((ban) => ban.ip !== ip),
          unbanned: [...(protection.unbanned || []), { ip, until: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }],
          lastSyncAt: null,
        },
      },
    });
    const credentials = await credentialsFor(project);
    if (credentials) await syncProjectSecurity({ projectId: project.id, credentials, force: true });
    return res.json({ message: `${ip} unbanned (exempt from automatic bans for 24 hours).` });
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

export const takeOffline = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    await assertProjectHasNoActiveOperation(project.id);
    const live = await liveDeployment(project.id);
    if (!live) return res.status(409).json({ message: "The site is not live." });
    if (project.siteOffline) return res.json({ message: "The site is already offline." });
    await takeSiteOffline({ credentials: await credentialsFor(project), resources: live.resources });
    await prisma.project.update({ where: { id: project.id }, data: { siteOffline: true, status: "Offline", protection: { ...(project.protection || {}), resuming: false } } });
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
    await startSiteTasks({ credentials: await credentialsFor(project), resources: live.resources });
    await prisma.project.update({ where: { id: project.id }, data: { siteOffline: false, status: "Starting", protection: { ...(project.protection || {}), resuming: true } } });
    // The monitor finishes the switch back once the container is healthy; make sure it is running.
    await addMonitorJob({ deploymentId: live.id, liveUrl: live.liveUrl, target: "ECS_FARGATE" }, { delay: 15_000, jobId: `monitor-${live.id}-resume-${Date.now()}` }).catch(() => {});
    return res.json({ message: "Starting the container. The maintenance page stays up until the app is healthy (usually 1-3 minutes)." });
  } catch (error) {
    return fail(res, error, "Failed to bring the site online");
  }
};
