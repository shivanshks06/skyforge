import crypto from "node:crypto";
import prisma from "../config/db.js";
import { Prisma } from "@prisma/client";
import { addDeploymentJob, getQueuePosition } from "../queues/deploymentQueue.js";
import { addRollbackJob } from "../queues/rollbackQueue.js";
import { subscribeToDeploymentLogs, getDeploymentLogs } from "../services/logsService.js";
import { addDestroyJob } from "../queues/destroyQueue.js";
import { requireOwnedDeployment, requireOwnedProject } from "../services/ownershipService.js";
import { maskObjectValues } from "../services/secretService.js";
import { getRedisStatus } from "../redis/connection.js";
import { toPublicDeployment } from "../services/deploymentSerializer.js";
import { toPublicProject } from "../services/projectSerializer.js";
import { normalizeTarget } from "../services/targets.js";
import { preflight, queueDeployment, lockProjectDeploymentOperations, buildTeardownSnapshot, credentialsForProject } from "../services/deploymentLauncher.js";
import { explainFailure } from "../services/errorExplainer.js";

const ACTIVE_STATUSES = ["QUEUED", "BUILDING", "PUSHING", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "ROLLING_BACK", "DESTROYING"];
const TERMINAL_LIVE_STATUSES = ["LIVE", "ROLLED_BACK"];

function workerJobIdFor(deploymentId) {
  return `deploy-${deploymentId}-${crypto.randomUUID()}`;
}

function rollbackJobIdFor(deploymentId) {
  return `rollback-${deploymentId}-${crypto.randomUUID()}`;
}


function destroyJobIdFor(deploymentId) {
  return `destroy-${deploymentId}-${crypto.randomUUID()}`;
}


export const triggerDeployment = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.projectId, req.user?.id);
    const { blockers } = await preflight(project);
    if (blockers.length) return res.status(422).json({ message: "Deployment preflight failed", blockers });
    if (!getRedisStatus().connected && process.env.ALLOW_INLINE_JOBS !== "true") {
      return res.status(503).json({ message: "Deployment queue is not ready" });
    }

    const { deployment, queueMode } = await queueDeployment(project, { trigger: "manual" });
    return res.status(202).json({
      message: "Deployment queued successfully",
      deploymentId: deployment.id,
      status: "QUEUED",
      queueMode,
      deployment: toPublicDeployment(deployment),
    });
  } catch (error) {
    console.error("Error queueing deployment:", error);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Failed to queue deployment" });
  }
};

export const retryDeployment = async (req, res) => {
  try {
    const deployment = await requireOwnedDeployment(req.params.id, req.user?.id);
    if (!["FAILED", "CANCELLED"].includes(deployment.status)) {
      return res.status(409).json({ message: `Only failed or cancelled deployments can be retried (current: ${deployment.status}).` });
    }
    const project = await requireOwnedProject(deployment.projectId, req.user?.id);
    const target = normalizeTarget(project.deploymentTarget);
    const { blockers } = await preflight(project);
    if (blockers.length) return res.status(422).json({ message: "Deployment preflight failed", blockers });

    const queued = await prisma.$transaction(async (tx) => {
      await lockProjectDeploymentOperations(tx, project.id);
      const current = await tx.deployment.findFirst({
        where: { id: deployment.id, projectId: project.id },
        select: { status: true },
      });
      if (!current || !["FAILED", "CANCELLED"].includes(current.status)) {
        const error = new Error("The deployment changed while retry was being prepared. Refresh and try again.");
        error.statusCode = 409;
        throw error;
      }
      const active = await tx.deployment.findFirst({
        where: { projectId: project.id, id: { not: deployment.id }, status: { in: ACTIVE_STATUSES } },
        select: { id: true },
      });
      if (active) {
        const error = new Error("Another deployment or teardown is already active for this project.");
        error.statusCode = 409;
        throw error;
      }
      const created = await tx.deployment.create({
        data: {
          projectId: project.id,
          retryOfId: deployment.id,
          status: "QUEUED",
          stage: "CLONING",
          currentStep: "CLONING",
          target,
          configVersion: project.configVersion,
          logs: [],
        },
      });
      const workerJobId = workerJobIdFor(created.id);
      const updated = await tx.deployment.update({
        where: { id: created.id },
        data: { workerJobId },
      });
      await tx.project.update({ where: { id: project.id }, data: { status: "Deploying" } });
      return { updated, workerJobId };
    }, { timeout: 15_000 });
    const { updated, workerJobId } = queued;
    let queueResult;
    try {
      queueResult = await addDeploymentJob({
        deploymentId: updated.id,
        projectId: project.id,
        userId: project.userId,
        target,
      }, { jobId: workerJobId });
    } catch (error) {
      await prisma.$transaction([
        prisma.deployment.update({
          where: { id: updated.id },
          data: { status: "FAILED", stage: "FAILED", currentStep: "CLONING", error: error.message, completedAt: new Date() },
        }),
        prisma.project.update({ where: { id: project.id }, data: { status: "Deployment Failed" } }),
      ]).catch(() => {});
      throw error;
    }
    return res.status(202).json({
      message: "Deployment retry queued as a new immutable attempt. The verified pipeline will rerun from the beginning.",
      deploymentId: updated.id,
      status: "QUEUED",
      retryMode: "FULL_PIPELINE_NEW_ATTEMPT",
      queueMode: queueResult.mode,
      deployment: toPublicDeployment(updated),
    });
  } catch (error) {
    console.error("Error retrying deployment:", error);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Failed to retry deployment" });
  }
};

export const rollbackDeployment = async (req, res) => {
  try {
    const deployment = await requireOwnedDeployment(req.params.id, req.user?.id);
    if (!TERMINAL_LIVE_STATUSES.includes(deployment.status)) {
      return res.status(409).json({ message: "Only a live or rolled-back deployment can be rolled back." });
    }
    const project = await requireOwnedProject(deployment.projectId, req.user?.id);
    const { blockers } = await preflight(project);
    if (blockers.length) return res.status(422).json({ message: "Rollback preflight failed", blockers });

    const rollback = await prisma.$transaction(async (tx) => {
      await lockProjectDeploymentOperations(tx, project.id);
      const current = await tx.deployment.findFirst({
        where: { id: deployment.id, projectId: project.id },
        select: { id: true, status: true, resources: true, createdAt: true },
      });
      if (!current || !TERMINAL_LIVE_STATUSES.includes(current.status)) {
        const error = new Error("The deployment changed while rollback was being prepared. Refresh and try again.");
        error.statusCode = 409;
        throw error;
      }
      const newer = await tx.deployment.findFirst({
        where: { projectId: project.id, id: { not: deployment.id }, createdAt: { gt: current.createdAt }, status: { notIn: ["FAILED", "CANCELLED"] } },
        select: { id: true },
      });
      if (newer) {
        const error = new Error("Only the newest deployment revision can be rolled back.");
        error.statusCode = 409;
        throw error;
      }
      const active = await tx.deployment.findFirst({
        where: { projectId: project.id, id: { not: deployment.id }, status: { in: ACTIVE_STATUSES } },
        select: { id: true },
      });
      if (active) {
        const error = new Error("Another deployment or teardown is already active for this project.");
        error.statusCode = 409;
        throw error;
      }

      const candidates = await tx.deployment.findMany({
        where: { projectId: project.id, id: { not: deployment.id }, status: { in: TERMINAL_LIVE_STATUSES }, resources: { not: Prisma.AnyNull } },
        orderBy: { createdAt: "desc" },
        select: { id: true, resources: true },
      });
      const resourceType = current.resources?.type;
      const previous = candidates.find((candidate) => {
        if (candidate.resources?.type !== resourceType) return false;
        if (resourceType === "ECS_FARGATE") {
          return Boolean(candidate.resources.taskDefinitionArn)
            && candidate.resources.clusterName === current.resources.clusterName
            && candidate.resources.serviceName === current.resources.serviceName;
        }
        if (resourceType === "S3_CLOUDFRONT") {
          return Boolean(candidate.resources.defaultRoot && candidate.resources.releasePrefix
            && candidate.resources.distributionId === current.resources.distributionId
            && candidate.resources.bucket === current.resources.bucket);
        }
        return false;
      });
      if (!previous) {
        const error = new Error("No compatible previous successful deployment revision is available to roll back to.");
        error.statusCode = 409;
        throw error;
      }
      const rollbackJobId = rollbackJobIdFor(deployment.id);
      await tx.deployment.update({ where: { id: deployment.id }, data: { status: "ROLLING_BACK", stage: "ROLLBACK", currentStep: "ROLLBACK", error: null, workerJobId: rollbackJobId, rollbackOriginalStatus: current.status } });
      return { previous, originalStatus: current.status, rollbackJobId };
    }, { timeout: 15_000 });
    try {
      await addRollbackJob({ deploymentId: deployment.id, projectId: project.id, userId: project.userId, previousDeploymentId: rollback.previous.id, reason: req.body?.reason || "User requested rollback" }, { jobId: rollback.rollbackJobId });
    } catch (error) {
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: {
          status: rollback.originalStatus,
          stage: "COMPLETE",
          currentStep: rollback.originalStatus === "LIVE" ? "LIVE" : "ROLLED_BACK",
          error: `Rollback was not queued: ${error.message}`,
          workerJobId: null,
          rollbackOriginalStatus: null,
        },
      }).catch(() => {});
      throw error;
    }
    return res.status(202).json({ message: "Rollback queued successfully", deploymentId: deployment.id, status: "ROLLING_BACK" });
  } catch (error) {
    console.error("Error rolling back deployment:", error);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Failed to rollback deployment" });
  }
};

export const getDeploymentQueuePosition = async (req, res) => {
  try {
    await requireOwnedDeployment(req.params.id, req.user?.id);
    return res.json(await getQueuePosition(req.params.id));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Failed to get queue position" });
  }
};

export const getDeployment = async (req, res) => {
  try {
    const deployment = await requireOwnedDeployment(req.params.id, req.user?.id);
    const deploymentWithProject = await prisma.deployment.findUnique({ where: { id: deployment.id }, include: { project: true } });
    if (!deploymentWithProject) return res.status(404).json({ message: "Deployment not found" });
    const logs = getDeploymentLogs(deployment.id);
    return res.json({
      deployment: {
        ...toPublicDeployment(deploymentWithProject),
        project: deploymentWithProject.project ? {
          ...toPublicProject(deploymentWithProject.project),
          envConfig: maskObjectValues(deploymentWithProject.project.envConfig || {}),
        } : null,
      },
      logs: logs.length ? logs : (Array.isArray(deploymentWithProject.logs) ? deploymentWithProject.logs : []),
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Failed to fetch deployment" });
  }
};

export const streamDeploymentLogs = async (req, res) => {
  try {
    const deployment = await requireOwnedDeployment(req.params.id, req.user?.id);
    await subscribeToDeploymentLogs(deployment.id, req, res);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to stream deployment logs" });
  }
};

export const getProjectDeployments = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.projectId, req.user?.id);
    const deployments = await prisma.deployment.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true, projectId: true, status: true, stage: true, currentStep: true, liveUrl: true,
        healthStatus: true, latencyMs: true, error: true, target: true, startedAt: true,
        completedAt: true, createdAt: true, updatedAt: true, retryOfId: true,
        trigger: true, commitSha: true, commitMessage: true, commitAuthor: true, stageTimings: true, restoredFromId: true, resources: true,
      },
    });
    const current = deployments.find((deployment) => TERMINAL_LIVE_STATUSES.includes(deployment.status));
    return res.json(deployments.map((deployment) => ({
      ...toPublicDeployment(deployment),
      isCurrent: deployment.id === current?.id,
      restorable: Boolean(current && deployment.id !== current.id && TERMINAL_LIVE_STATUSES.includes(deployment.status) && sameService(current.resources, deployment.resources)),
    })));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Failed to fetch project deployments" });
  }
};

export const destroyDeploymentInfrastructure = async (req, res) => {
  try {
    const deploymentId = req.params.id;
    const projectId = req.params.projectId;
    const project = projectId
      ? await requireOwnedProject(projectId, req.user?.id)
      : await requireOwnedProject((await requireOwnedDeployment(deploymentId, req.user?.id)).projectId, req.user?.id);
    if (!project) return res.status(404).json({ message: "Project not found" });
    if (!getRedisStatus().connected && process.env.ALLOW_INLINE_JOBS !== "true") {
      return res.status(503).json({ message: "Infrastructure teardown queue is not ready" });
    }

    const deployment = await prisma.$transaction(async (tx) => {
      await lockProjectDeploymentOperations(tx, project.id);
      const active = await tx.deployment.findFirst({ where: { projectId: project.id, status: { in: ACTIVE_STATUSES } } });
      if (active) {
        const error = new Error("Wait for the active deployment or teardown to finish before destroying infrastructure.");
        error.statusCode = 409;
        throw error;
      }

      const snapshot = await buildTeardownSnapshot(tx, project.id);
      if (!deploymentId) {
        const created = await tx.deployment.create({
          data: {
            projectId: project.id,
            status: "DESTROYING",
            stage: "DESTROY",
            currentStep: "DESTROY",
            teardownResources: snapshot.resources,
            teardownDeploymentIds: snapshot.deploymentIds,
          },
        });
        const workerJobId = destroyJobIdFor(created.id);
        return tx.deployment.update({
          where: { id: created.id },
          data: { workerJobId, teardownDeploymentIds: [...snapshot.deploymentIds, created.id] },
        });
      }
      const ownedDeployment = await tx.deployment.findFirst({ where: { id: deploymentId, projectId: project.id }, select: { id: true, status: true } });
      if (!ownedDeployment) {
        const error = new Error("Deployment not found");
        error.statusCode = 404;
        throw error;
      }
      if (ownedDeployment.status === "DESTROYED") {
        const error = new Error("This deployment has already been torn down. Use project teardown for any remaining project resources.");
        error.statusCode = 409;
        throw error;
      }
      const workerJobId = destroyJobIdFor(deploymentId);
      return tx.deployment.update({
        where: { id: deploymentId },
        data: {
          status: "DESTROYING",
          stage: "DESTROY",
          currentStep: "DESTROY",
          workerJobId,
          teardownResources: snapshot.resources,
          teardownDeploymentIds: snapshot.deploymentIds,
          error: null,
        },
      });
    }, { timeout: 15_000 });

    let queueResult;
    try {
      queueResult = await addDestroyJob({ projectId: project.id, deploymentId: deployment.id, userId: project.userId }, { jobId: deployment.workerJobId });
    } catch (error) {
      await prisma.$transaction([
        prisma.deployment.update({
          where: { id: deployment.id },
          data: { status: "DESTROY_FAILED", stage: "DESTROY_FAILED", currentStep: "DESTROY", workerJobId: null, error: error.message, completedAt: new Date() },
        }),
        prisma.project.update({ where: { id: project.id }, data: { status: "Teardown Failed" } }),
      ]).catch(() => {});
      throw error;
    }
    return res.status(202).json({
      message: "Cloud teardown initiated",
      status: "DESTROYING",
      deploymentId: deployment.id,
      projectId: project.id,
      queueMode: queueResult.mode,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Failed to initiate infrastructure teardown" });
  }
};

/** Two deployments run on the same ECS service or the same S3 + CloudFront site, so one can replace the other. */
function sameService(a, b) {
  if (!a?.type || a.type !== b?.type) return false;
  if (a.type === "ECS_FARGATE") return Boolean(b.taskDefinitionArn) && a.clusterName === b.clusterName && a.serviceName === b.serviceName;
  if (a.type === "S3_CLOUDFRONT") return Boolean(b.defaultRoot && b.releasePrefix) && a.distributionId === b.distributionId && a.bucket === b.bucket;
  return false;
}

/** Restores any earlier successful version of the site (not just the previous one). */
export const restoreDeployment = async (req, res) => {
  try {
    const chosen = await requireOwnedDeployment(req.params.id, req.user?.id);
    const project = await requireOwnedProject(chosen.projectId, req.user?.id);
    const { blockers } = await preflight(project);
    if (blockers.length) return res.status(422).json({ message: "Restore preflight failed", blockers });
    if (chosen.resources?.type === "ECS_FARGATE") {
      const missing = await missingImage(project, chosen.resources).catch(() => null);
      if (missing) return res.status(409).json({ message: missing });
    }

    const plan = await prisma.$transaction(async (tx) => {
      await lockProjectDeploymentOperations(tx, project.id);
      const active = await tx.deployment.findFirst({ where: { projectId: project.id, status: { in: ACTIVE_STATUSES } }, select: { id: true } });
      if (active) {
        const error = new Error("Wait for the current deployment or teardown to finish first.");
        error.statusCode = 409;
        throw error;
      }
      const current = await tx.deployment.findFirst({
        where: { projectId: project.id, status: { in: TERMINAL_LIVE_STATUSES } },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, resources: true },
      });
      const target = await tx.deployment.findFirst({ where: { id: chosen.id, projectId: project.id }, select: { id: true, status: true, resources: true } });
      if (!current || !target || current.id === target.id) {
        const error = new Error(current && current.id === target?.id ? "That version is already live." : "The site isn't live, so there is nothing to restore over. Deploy it instead.");
        error.statusCode = 409;
        throw error;
      }
      if (!TERMINAL_LIVE_STATUSES.includes(target.status) || !sameService(current.resources, target.resources)) {
        const error = new Error("That version can't be restored: it ran on infrastructure that no longer exists or was replaced.");
        error.statusCode = 409;
        throw error;
      }
      const rollbackJobId = rollbackJobIdFor(current.id);
      await tx.deployment.update({
        where: { id: current.id },
        data: { status: "ROLLING_BACK", stage: "ROLLBACK", currentStep: "ROLLBACK", error: null, workerJobId: rollbackJobId, rollbackOriginalStatus: current.status, restoredFromId: target.id },
      });
      return { current, target, rollbackJobId };
    }, { timeout: 15_000 });

    try {
      await addRollbackJob({
        deploymentId: plan.current.id,
        projectId: project.id,
        userId: project.userId,
        previousDeploymentId: plan.target.id,
        reason: `restore the version from ${new Date(chosen.createdAt).toISOString().replace("T", " ").slice(0, 16)} UTC`,
      }, { jobId: plan.rollbackJobId });
    } catch (error) {
      await prisma.deployment.update({
        where: { id: plan.current.id },
        data: { status: plan.current.status, stage: "COMPLETE", currentStep: plan.current.status === "LIVE" ? "LIVE" : "ROLLED_BACK", error: `Restore was not queued: ${error.message}`, workerJobId: null, rollbackOriginalStatus: null, restoredFromId: null },
      }).catch(() => {});
      throw error;
    }
    return res.status(202).json({ message: "Restoring that version. The site switches over once it passes health checks.", deploymentId: plan.current.id, status: "ROLLING_BACK" });
  } catch (error) {
    console.error("Error restoring deployment:", error.message);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Failed to restore that version" });
  }
};

/** The image an old ECS version runs must still exist in ECR; returns a message when it was deleted. */
async function missingImage(project, resources) {
  const credentials = await credentialsForProject(project);
  const region = resources.region || credentials.region;
  const auth = { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}) };
  const { ECSClient, DescribeTaskDefinitionCommand } = await import("@aws-sdk/client-ecs");
  const { ECRClient, DescribeImagesCommand } = await import("@aws-sdk/client-ecr");
  const definition = await new ECSClient({ region, credentials: auth }).send(new DescribeTaskDefinitionCommand({ taskDefinition: resources.taskDefinitionArn }));
  const image = definition.taskDefinition?.containerDefinitions?.[0]?.image || "";
  const match = image.match(/^[^/]+\/([^:@]+)(?:@(sha256:[0-9a-f]+)|:([\w.-]+))?$/);
  if (!match) return null;
  try {
    await new ECRClient({ region, credentials: auth }).send(new DescribeImagesCommand({ repositoryName: match[1], imageIds: [match[2] ? { imageDigest: match[2] } : { imageTag: match[3] || "latest" }] }));
    return null;
  } catch (error) {
    if (/ImageNotFound|RepositoryNotFound/i.test(error.name)) return "That version's container image was deleted from ECR, so it can't be restored. Redeploy that commit instead.";
    throw error;
  }
}

/** Why a deployment failed, in plain English, with one-click fixes. */
export const getDiagnosis = async (req, res) => {
  try {
    const deployment = await requireOwnedDeployment(req.params.id, req.user?.id);
    const project = await requireOwnedProject(deployment.projectId, req.user?.id);
    const memory = getDeploymentLogs(deployment.id);
    const logs = memory.length ? memory : (Array.isArray(deployment.logs) ? deployment.logs : []);
    return res.json({ diagnosis: explainFailure({ deployment, project, logs }) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Failed to explain the deployment" });
  }
};

const durationOf = (row) => (row?.startedAt && row?.completedAt ? new Date(row.completedAt) - new Date(row.startedAt) : null);

/** Every deployment across the person's projects, newest first, for the history timeline. */
export const getDeploymentHistory = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 300);
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const rows = await prisma.deployment.findMany({
      where: { project: { userId: req.user.id }, ...(projectId ? { projectId } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true, projectId: true, status: true, currentStep: true, liveUrl: true, error: true, target: true, configVersion: true,
        startedAt: true, completedAt: true, createdAt: true, trigger: true, commitSha: true, commitMessage: true, commitAuthor: true,
        stageTimings: true, restoredFromId: true, retryOfId: true,
        project: { select: { id: true, name: true, repoName: true, parentProjectId: true, previewPr: true } },
      },
    });
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { name: true } });
    // Each deployment is compared with the previous deployment (not a teardown record) of the same project.
    const previousOf = new Map();
    const lastByProject = new Map();
    for (const row of [...rows].reverse()) {
      if (lastByProject.has(row.projectId)) previousOf.set(row.id, lastByProject.get(row.projectId));
      if (row.target) lastByProject.set(row.projectId, row); // teardown records have no target
    }
    return res.json(rows.map((row) => {
      const previous = previousOf.get(row.id);
      return {
        ...row,
        error: row.error ? row.error.split(/\r?\n/)[0].slice(0, 240) : null,
        by: row.trigger === "push" || row.trigger === "preview" ? (row.commitAuthor || "GitHub") : user?.name || "You",
        durationMs: durationOf(row),
        previous: previous ? { id: previous.id, commitSha: previous.commitSha, status: previous.status, configVersion: previous.configVersion, target: previous.target, durationMs: durationOf(previous) } : null,
        compareUrl: previous?.commitSha && row.commitSha && previous.commitSha !== row.commitSha
          ? `https://github.com/${row.project.repoName}/compare/${previous.commitSha.slice(0, 12)}...${row.commitSha.slice(0, 12)}`
          : null,
      };
    }));
  } catch (error) {
    console.error("Error loading deployment history:", error.message);
    return res.status(500).json({ message: "Failed to load deployment history" });
  }
};
