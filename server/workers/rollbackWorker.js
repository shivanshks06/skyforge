import { Worker } from "bullmq";
import connection from "../redis/connection.js";
import prisma from "../config/db.js";
import { emitDeploymentLog } from "../services/logsService.js";
import { getAwsCredentials } from "../services/awsConnectionService.js";
import { rollbackEcs } from "../services/ecsService.js";
import { rollbackStaticDistribution } from "../services/staticDeployer.js";
import { probeEndpoint } from "../services/healthService.js";
import { mergeRollbackResources } from "../services/resourceUtils.js";
import { addMonitorJob } from "../queues/monitorQueue.js";

async function credentialsFor(userId) {
  const record = await prisma.awsConnection.findUnique({ where: { userId } });
  if (record) {
    const credentials = await getAwsCredentials(record);
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
  throw new Error("No AWS connection is configured for rollback.");
}

function staleRollbackError() {
  const error = new Error("This rollback operation was superseded by a newer deployment.");
  error.code = "ROLLBACK_SUPERSEDED";
  return error;
}

async function claimRollback({ deploymentId, projectId, userId, rollbackJobId }) {
  return prisma.$transaction(async (tx) => {
    const lockKey = `skyforge:project-deployments:${projectId}`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text AS acquired`;
    const deployment = await tx.deployment.findFirst({
      where: { id: deploymentId, projectId, project: { userId } },
    });
    if (!deployment || deployment.workerJobId !== rollbackJobId || !["LIVE", "ROLLED_BACK", "ROLLING_BACK"].includes(deployment.status)) return null;
    const newer = await tx.deployment.findFirst({
      where: { projectId, id: { not: deploymentId }, createdAt: { gt: deployment.createdAt } },
      select: { id: true },
    });
    if (newer) return null;
    await tx.deployment.update({ where: { id: deploymentId }, data: { status: "ROLLING_BACK", stage: "ROLLBACK", currentStep: "ROLLBACK", error: null } });
    return deployment;
  }, { timeout: 15_000 });
}

export async function processRollbackJob(job) {
  const { deploymentId, projectId, userId, previousDeploymentId, reason } = job.data;
  const rollbackJobId = String(job.id || "");
  let originalStatus = "LIVE";
  try {
    if (!rollbackJobId) throw staleRollbackError();
    const [project, previous] = await Promise.all([
      prisma.project.findFirst({ where: { id: projectId, userId } }),
      prisma.deployment.findFirst({ where: { id: previousDeploymentId, projectId, project: { userId } } }),
    ]);
    if (!project || !previous?.resources) throw new Error("Deployment revision or project was not found.");
    const deploymentSnapshot = await prisma.deployment.findFirst({ where: { id: deploymentId, projectId }, select: { configVersion: true } });
    if (deploymentSnapshot?.configVersion !== null && deploymentSnapshot?.configVersion !== undefined && project.configVersion !== deploymentSnapshot.configVersion) {
      throw new Error("Project configuration changed after this deployment was queued; rollback was not started.");
    }
    const deployment = await claimRollback({ deploymentId, projectId, userId, rollbackJobId });
    if (!deployment) throw staleRollbackError();
    originalStatus = deployment.rollbackOriginalStatus || (["LIVE", "ROLLED_BACK"].includes(deployment.status) ? deployment.status : "LIVE");

    const currentResources = deployment.resources || {};
    const previousResources = previous.resources || {};
    const credentials = await credentialsFor(userId);
    const resourceCredentials = currentResources.region ? { ...credentials, region: currentResources.region } : credentials;
    emitDeploymentLog(deploymentId, { stage: "ROLLBACK", message: `[ROLLBACK] Restoring the previous verified deployment revision. Reason: ${reason || "manual rollback"}`, level: "warn" });
    if (currentResources.type === "ECS_FARGATE") {
      await rollbackEcs({ credentials: resourceCredentials, resources: currentResources, previousTaskDefinitionArn: previousResources.taskDefinitionArn });
    } else if (currentResources.type === "S3_CLOUDFRONT") {
      await rollbackStaticDistribution({ credentials: resourceCredentials, resources: currentResources, previousResources });
    } else {
      throw new Error("The current deployment has no supported rollback resource manifest.");
    }

    const endpoint = deployment.liveUrl || previous.liveUrl;
    if (!endpoint) throw new Error("The rollback endpoint could not be determined.");
    const healthPath = typeof project.healthCheck === "string" && /^\/[A-Za-z0-9/_-]*$/.test(project.healthCheck) ? project.healthCheck : "/";
    const health = await probeEndpoint(endpoint, {
      attempts: 8,
      timeoutMs: 10_000,
      ...(currentResources.type === "ECS_FARGATE" ? { path: healthPath } : {}),
    });
    emitDeploymentLog(deploymentId, {
      stage: "ROLLBACK_HEALTH_CHECK",
      message: `[HEALTH] ${health.endpoint} returned HTTP ${health.status} after rollback.`,
      level: "success",
    });

    const rolledBackResources = mergeRollbackResources(currentResources, previousResources);

    const completion = await prisma.deployment.updateMany({
      where: { id: deploymentId, workerJobId: rollbackJobId, status: "ROLLING_BACK" },
      data: {
        status: "ROLLED_BACK",
        stage: "COMPLETE",
        currentStep: "ROLLED_BACK",
        liveUrl: health.endpoint,
        healthStatus: "HEALTHY",
        latencyMs: health.latencyMs,
        resources: rolledBackResources,
        artifactPath: previous.artifactPath || null,
        workerJobId: null,
        rollbackOriginalStatus: null,
        completedAt: new Date(),
        error: null,
      },
    });
    if (completion.count !== 1) throw staleRollbackError();
    await addMonitorJob({ deploymentId, projectId, liveUrl: health.endpoint, target: currentResources.type }, { jobId: `monitor-${deploymentId}-${Math.floor(Date.now() / 60_000) + 1}` }).catch((error) => {
      console.warn(`[MONITOR] Rollback monitoring was not queued: ${error.message}`);
    });
    emitDeploymentLog(deploymentId, { stage: "ROLLBACK_COMPLETE", message: "[ROLLBACK] Previous verified revision restored successfully.", level: "success" });
    return { success: true, previousDeploymentId };
  } catch (error) {
    if (error.code === "ROLLBACK_SUPERSEDED") throw error;
    await prisma.deployment.updateMany({
      where: { id: deploymentId, workerJobId: rollbackJobId, status: { in: ["ROLLING_BACK", "LIVE", "ROLLED_BACK"] } },
      data: {
        status: originalStatus,
        stage: "COMPLETE",
        currentStep: originalStatus === "LIVE" ? "LIVE" : "ROLLED_BACK",
        error: `Rollback failed: ${String(error.message).slice(0, 2000)}`,
        completedAt: new Date(),
      },
    }).catch(() => {});
    emitDeploymentLog(deploymentId, { stage: "ROLLBACK_FAILED", message: `[ERROR] Rollback failed: ${error.message}`, level: "error" });
    throw error;
  }
}

let rollbackWorker = null;
if (process.env.START_WORKERS === "true") {
  rollbackWorker = new Worker("rollbacks", processRollbackJob, { connection, concurrency: 1 });
  rollbackWorker.on("completed", (job) => console.log(`[WORKER:rollbacks] Job ${job.id} completed.`));
  rollbackWorker.on("failed", (job, error) => console.error(`[WORKER:rollbacks] Job ${job?.id} failed: ${error.message}`));
  rollbackWorker.on("error", (error) => console.warn(`[WORKER:rollbacks] ${error.message}`));
}

export async function closeRollbackWorker() {
  if (rollbackWorker) await rollbackWorker.close();
}

export default rollbackWorker;
