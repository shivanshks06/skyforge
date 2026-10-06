// Project features that run after deploy: auto-deploy and previews, custom domains, cost preview,
// monitoring (app logs + metrics), runtime settings, and the public status page.
import prisma from "../config/db.js";
import { requireOwnedProject } from "../services/ownershipService.js";
import { assertProjectHasNoActiveOperation } from "../services/operationGuard.js";
import { credentialsForProject } from "../services/deploymentLauncher.js";
import { runGitWatch, headCommit, MAX_PREVIEWS } from "../services/gitWatcher.js";
import { requestDomain, refreshDomain, removeDomain } from "../services/domainService.js";
import { projectedCost } from "../services/costService.js";
import { appMetrics, appLogs, METRIC_RANGES } from "../services/monitoringService.js";
import { newStatusSlug, uptimeHistory } from "../services/statusService.js";

function fail(res, error, fallback) {
  const status = error.statusCode || (error.name === "AccessDeniedException" || /not authorized/i.test(error.message || "") ? 403 : 500);
  if (status >= 500) console.error(`[AUTOMATION] ${fallback}:`, error.message);
  return res.status(status).json({ message: status < 500 ? error.message : `${fallback}: ${String(error.message || "").slice(0, 200)}` });
}

async function liveDeployment(projectId) {
  return prisma.deployment.findFirst({
    where: { projectId, status: { in: ["LIVE", "ROLLED_BACK"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, resources: true, liveUrl: true, createdAt: true },
  });
}

// ---------------------------------------------------------------- auto-deploy and previews

async function automationState(project) {
  const previews = await prisma.project.findMany({
    where: { parentProjectId: project.id },
    orderBy: { previewPr: "asc" },
    select: {
      id: true, name: true, branch: true, previewPr: true, status: true, gitWatch: true,
      deployments: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, liveUrl: true, createdAt: true } },
    },
  });
  return {
    autoDeploy: project.autoDeploy,
    previewsEnabled: project.previewsEnabled,
    branch: project.branch,
    watch: project.gitWatch || null,
    maxPreviews: MAX_PREVIEWS,
    webhook: { enabled: Boolean(process.env.GITHUB_WEBHOOK_SECRET), path: "/api/github/webhook" },
    previews: previews.map(({ deployments, ...preview }) => ({ ...preview, latestDeployment: deployments[0] || null })),
  };
}

export const getAutomation = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    return res.json(await automationState(project));
  } catch (error) {
    return fail(res, error, "Failed to load automation settings");
  }
};

export const updateAutomation = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    if (project.parentProjectId) return res.status(400).json({ message: "Previews follow their pull request; change settings on the main project." });
    const data = {};
    if (typeof req.body?.autoDeploy === "boolean") data.autoDeploy = req.body.autoDeploy;
    if (typeof req.body?.previewsEnabled === "boolean") data.previewsEnabled = req.body.previewsEnabled;
    if (!Object.keys(data).length) return res.status(400).json({ message: "Send autoDeploy and/or previewsEnabled as true or false." });
    if (data.autoDeploy && !project.autoDeploy) {
      // Start from the branch as it is now, so switching this on never redeploys an old commit.
      const commit = await headCommit(project).catch(() => null);
      data.gitWatch = { ...(project.gitWatch || {}), headSha: commit?.sha || null, lastError: null, checkedAt: new Date().toISOString() };
    }
    const updated = await prisma.project.update({ where: { id: project.id }, data });
    return res.json(await automationState(updated));
  } catch (error) {
    return fail(res, error, "Failed to update automation settings");
  }
};

export const checkGitNow = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    const summary = await runGitWatch({ repoName: project.repoName });
    const fresh = await prisma.project.findUnique({ where: { id: project.id } });
    return res.json({ summary, ...(await automationState(fresh)) });
  } catch (error) {
    return fail(res, error, "Failed to check GitHub");
  }
};

// ---------------------------------------------------------------- custom domain

export const getDomain = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    return res.json({ domain: project.customDomain || null });
  } catch (error) {
    return fail(res, error, "Failed to load the custom domain");
  }
};

export const addDomain = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    await assertProjectHasNoActiveOperation(project.id);
    const domain = await requestDomain({ project, credentials: await credentialsForProject(project), domain: req.body?.domain });
    return res.status(201).json({ domain });
  } catch (error) {
    return fail(res, error, "Failed to add the custom domain");
  }
};

export const checkDomain = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    if (!project.customDomain) return res.status(404).json({ message: "No custom domain is set." });
    const domain = await refreshDomain({ project, credentials: await credentialsForProject(project) });
    return res.json({ domain });
  } catch (error) {
    return fail(res, error, "Failed to check the custom domain");
  }
};

export const deleteDomain = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    await assertProjectHasNoActiveOperation(project.id);
    await removeDomain({ project, credentials: await credentialsForProject(project) });
    return res.json({ domain: null, message: "The domain was removed and its certificate deleted. Delete the DNS records at your domain provider too." });
  } catch (error) {
    return fail(res, error, "Failed to remove the custom domain");
  }
};

// ---------------------------------------------------------------- cost preview

export const getCostPreview = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    return res.json({ cost: projectedCost(project) });
  } catch (error) {
    return fail(res, error, "Failed to estimate costs");
  }
};

// ---------------------------------------------------------------- monitoring

export const getMetrics = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    const live = await liveDeployment(project.id);
    if (!live?.resources) return res.status(409).json({ message: "The site isn't live, so there is nothing to measure yet." });
    const range = METRIC_RANGES.includes(req.query.range) ? req.query.range : "1h";
    const metrics = await appMetrics({ credentials: await credentialsForProject(project), resources: live.resources, range });
    return res.json({ ...metrics, deploymentId: live.id, liveUrl: live.liveUrl, offline: project.siteOffline });
  } catch (error) {
    return fail(res, error, "Failed to load metrics");
  }
};

export const getAppLogs = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    const live = await liveDeployment(project.id);
    if (!live?.resources) return res.status(409).json({ message: "The site isn't live, so there are no app logs yet." });
    const minutes = Number.parseInt(req.query.minutes, 10);
    const result = await appLogs({
      credentials: await credentialsForProject(project),
      resources: live.resources,
      sinceMs: (Number.isFinite(minutes) ? minutes : 15) * 60_000,
      after: req.query.after ? Number(req.query.after) : null,
      filter: typeof req.query.filter === "string" ? req.query.filter : "",
    });
    return res.json(result);
  } catch (error) {
    return fail(res, error, "Failed to load app logs");
  }
};

export const getUptime = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    return res.json({ history: await uptimeHistory(project.id, 30) });
  } catch (error) {
    return fail(res, error, "Failed to load uptime");
  }
};

// ---------------------------------------------------------------- runtime settings (port, size, health check)

const CPU_MEMORY = { "0.25 vCPU": ["512 MB", "1 GB", "2 GB"], "0.5 vCPU": ["1 GB", "2 GB", "4 GB"], "1 vCPU": ["2 GB", "4 GB"], "2 vCPU": ["4 GB"] };

export const updateRuntime = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    await assertProjectHasNoActiveOperation(project.id);
    const data = {};
    if (req.body?.port !== undefined) {
      const port = Number(req.body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ message: "Port must be a whole number from 1 to 65535." });
      data.port = port;
    }
    if (req.body?.healthCheck !== undefined) {
      const path = String(req.body.healthCheck);
      if (!/^\/[A-Za-z0-9/_-]*$/.test(path) || path.length > 100) return res.status(400).json({ message: "Health check must be a path like / or /health." });
      data.healthCheck = path;
    }
    const cpu = req.body?.cpu ?? project.cpu ?? "0.5 vCPU";
    const memory = req.body?.memory ?? project.memory ?? "1 GB";
    if (req.body?.cpu !== undefined || req.body?.memory !== undefined) {
      if (!CPU_MEMORY[cpu]?.includes(memory)) return res.status(400).json({ message: `AWS Fargate can't run ${cpu} with ${memory}. Valid memory for ${cpu}: ${(CPU_MEMORY[cpu] || []).join(", ") || "none"}.` });
      data.cpu = cpu;
      data.memory = memory;
    }
    if (!Object.keys(data).length) return res.status(400).json({ message: "Nothing to change." });
    const updated = await prisma.project.update({ where: { id: project.id }, data: { ...data, configVersion: { increment: 1 } } });
    return res.json({ port: updated.port, cpu: updated.cpu, memory: updated.memory, healthCheck: updated.healthCheck, message: "Saved. The change takes effect on the next deploy." });
  } catch (error) {
    return fail(res, error, "Failed to update runtime settings");
  }
};

// ---------------------------------------------------------------- status page

export const getStatusPage = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    return res.json({ statusPage: project.statusPage || { enabled: false } });
  } catch (error) {
    return fail(res, error, "Failed to load the status page settings");
  }
};

export const updateStatusPage = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    const current = project.statusPage || {};
    const next = {
      ...current,
      enabled: typeof req.body?.enabled === "boolean" ? req.body.enabled : Boolean(current.enabled),
      title: typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 80) || null : current.title || null,
    };
    if (!next.slug || req.body?.newLink === true) next.slug = newStatusSlug(project.name);
    await prisma.project.update({ where: { id: project.id }, data: { statusPage: next } });
    return res.json({ statusPage: next });
  } catch (error) {
    return fail(res, error, "Failed to update the status page");
  }
};
