import crypto from "node:crypto";
import prisma from "../config/db.js";
import { Prisma } from "@prisma/client";
import { addDeploymentJob, getQueuePosition, removeDeploymentJobs } from "../queues/deploymentQueue.js";
import { addRollbackJob } from "../queues/rollbackQueue.js";
import { subscribeToDeploymentLogs, getDeploymentLogs } from "../services/logsService.js";
import { addDestroyJob } from "../queues/destroyQueue.js";
import { requireOwnedDeployment, requireOwnedProject } from "../services/ownershipService.js";
import { getAwsCredentials } from "../services/awsConnectionService.js";
import { decryptObjectValues, maskObjectValues } from "../services/secretService.js";
import { getRedisStatus } from "../redis/connection.js";
import { toPublicDeployment } from "../services/deploymentSerializer.js";
import { toPublicProject } from "../services/projectSerializer.js";
import { effectiveRequiredEnv } from "../services/envScanner.js";
import { usesManagedDatabase, managedDatabaseKeys } from "../services/rdsService.js";
import { normalizeTarget, TARGETS } from "../services/targets.js";
import { uniqueResources, validateResourceManifests } from "../services/resourceUtils.js";

const ACTIVE_STATUSES = ["QUEUED", "BUILDING", "PUSHING", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "ROLLING_BACK", "DESTROYING"];
const SUPERSEDABLE_STATUSES = ["QUEUED", "BUILDING"];
const TERMINAL_LIVE_STATUSES = ["LIVE", "ROLLED_BACK"];

function workerJobIdFor(deploymentId) {
  return `deploy-${deploymentId}-${crypto.randomUUID()}`;
}

function rollbackJobIdFor(deploymentId) {
  return `rollback-${deploymentId}-${crypto.randomUUID()}`;
}

async function lockProjectDeploymentOperations(tx, projectId) {
  const lockKey = `skyforge:project-deployments:${projectId}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text AS acquired`;
}

function destroyJobIdFor(deploymentId) {
  return `destroy-${deploymentId}-${crypto.randomUUID()}`;
}

async function buildTeardownSnapshot(tx, projectId) {
  const deployments = await tx.deployment.findMany({
    where: { projectId, status: { not: "DESTROYED" } },
    select: { id: true, status: true, resources: true },
    orderBy: { createdAt: "asc" },
  });
  try {
    return {
      deploymentIds: deployments.map(({ id }) => id),
      resources: validateResourceManifests(uniqueResources(deployments)),
    };
  } catch (error) {
    error.statusCode = error.statusCode || 422;
    throw error;
  }
}

async function credentialsForProject(project) {
  const connection = await prisma.awsConnection.findUnique({ where: { userId: project.userId } });
  if (connection) {
    const credentials = await getAwsCredentials(connection);
    if (credentials?.accessKeyId) return credentials;
  }

  if (process.env.ALLOW_PLATFORM_AWS === "true" && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
      region: process.env.AWS_REGION || "ap-south-1",
      accountId: process.env.AWS_ACCOUNT_ID,
    };
  }
  throw new Error("Connect an AWS account before deploying a project.");
}

async function preflight(project) {
  const blockers = [];
  let credentials;
  try {
    credentials = await credentialsForProject(project);
  } catch (error) {
    blockers.push(error.message);
  }

  const target = normalizeTarget(project.deploymentTarget);
  if (!target) blockers.push("Choose a deployment target (ECS Fargate, ECS Fargate + CloudFront, or S3 + CloudFront) on the Infrastructure page.");
  if (target === TARGETS.S3_CLOUDFRONT && !/^\d{12}$/.test(credentials?.accountId || "")) blockers.push("The AWS account ID is needed for the S3 bucket name; reconnect AWS.");
  // Static sites have no server, so runtime variables do not apply.
  // A SkyForge-managed database supplies DATABASE_URL and friends itself.
  const managed = usesManagedDatabase(project) ? managedDatabaseKeys(project.databaseConfig.engine) : [];
  const required = target === TARGETS.S3_CLOUDFRONT ? [] : effectiveRequiredEnv(project).filter((key) => !managed.includes(key));
  const configured = decryptObjectValues(project.envConfig || {});
  for (const key of required) {
    if (configured[key] === undefined || configured[key] === null || String(configured[key]).trim() === "") blockers.push(`Environment variable ${key} is not configured.`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project.repoName) || project.repoName.includes("..")) blockers.push("The GitHub repository identity is invalid.");
  if (!/^[\w./-]+$/.test(project.branch || "") || String(project.branch || "").includes("..")) blockers.push("The Git branch name is invalid.");
  if (!credentials?.region) blockers.push("AWS region is not configured.");
  return { blockers };
}

export const triggerDeployment = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.projectId, req.user?.id);
    const target = normalizeTarget(project.deploymentTarget);
    const { blockers } = await preflight(project);
    if (blockers.length) return res.status(422).json({ message: "Deployment preflight failed", blockers });
    if (!getRedisStatus().connected && process.env.ALLOW_INLINE_JOBS !== "true") {
      return res.status(503).json({ message: "Deployment queue is not ready" });
    }

    let supersededProject = false;
    const queued = await prisma.$transaction(async (tx) => {
      await lockProjectDeploymentOperations(tx, project.id);
      const blocking = await tx.deployment.findFirst({ where: { projectId: project.id, status: { in: ["PUSHING", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "ROLLING_BACK", "DESTROYING"] } } });
      if (blocking) {
        const error = new Error(`Wait for the current ${blocking.status.toLowerCase().replaceAll("_", " ")} operation to finish.`);
        error.statusCode = 409;
        throw error;
      }
      const active = await tx.deployment.findFirst({ where: { projectId: project.id, status: { in: SUPERSEDABLE_STATUSES } } });
      if (active) {
        supersededProject = true;
        await tx.deployment.updateMany({
          where: { projectId: project.id, status: { in: SUPERSEDABLE_STATUSES } },
          data: {
            status: "CANCELLED",
            stage: "CANCELLED",
            currentStep: "CANCELLED",
            error: "Superseded by a new deployment",
            workerJobId: null,
            completedAt: new Date(),
          },
        });
      }

      const created = await tx.deployment.create({
        data: {
          projectId: project.id,
          status: "QUEUED",
          stage: "QUEUED",
          currentStep: "QUEUED",
          target,
          configVersion: project.configVersion,
          logs: [],
        },
      });
      const workerJobId = workerJobIdFor(created.id);
      const deployment = await tx.deployment.update({ where: { id: created.id }, data: { workerJobId } });
      await tx.project.update({ where: { id: project.id }, data: { status: "Deploying" } });
      return { deployment, workerJobId };
    }, { timeout: 15_000 });

    const { deployment, workerJobId } = queued;
    if (supersededProject) await removeDeploymentJobs(project.id).catch(() => {});
    try {
      const queueResult = await addDeploymentJob({
        deploymentId: deployment.id,
        projectId: project.id,
        userId: project.userId,
        target,
      }, { jobId: workerJobId });
      return res.status(202).json({
        message: "Deployment queued successfully",
        deploymentId: deployment.id,
        status: "QUEUED",
        queueMode: queueResult.mode,
        deployment: toPublicDeployment(deployment),
      });
    } catch (error) {
      await prisma.$transaction([
        prisma.deployment.update({ where: { id: deployment.id }, data: { status: "FAILED", stage: "FAILED", error: error.message, completedAt: new Date() } }),
        prisma.project.update({ where: { id: project.id }, data: { status: "Deployment Failed" } }),
      ]);
      throw error;
    }
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
        where: { projectId: project.id, id: { not: deployment.id }, createdAt: { gt: current.createdAt } },
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
      },
    });
    return res.json(deployments.map(toPublicDeployment));
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
