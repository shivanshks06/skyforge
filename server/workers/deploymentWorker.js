import dns from "node:dns";
import net from "node:net";

if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}
if (typeof net.setDefaultAutoSelectFamily === "function") {
  net.setDefaultAutoSelectFamily(false);
}

import { Worker } from "bullmq";
import { Prisma } from "@prisma/client";
import connection from "../redis/connection.js";
import prisma from "../config/db.js";
import { emitDeploymentLog, getDeploymentLogs, persistDeploymentLogs } from "../services/logsService.js";
import { getAwsCredentials } from "../services/awsConnectionService.js";
import { prepareRepository, buildStaticAssets, buildContainerImage } from "../services/sourceService.js";
import { pushImageToEcr } from "../services/ecrService.js";
import { deployToEcs, rollbackEcs } from "../services/ecsService.js";
import { deployStaticProject, rollbackStaticDistribution } from "../services/staticDeployer.js";
import { probeEndpoint } from "../services/healthService.js";
import { addMonitorJob } from "../queues/monitorQueue.js";

const RUNNABLE_DEPLOYMENT_STATUSES = ["QUEUED", "BUILDING", "PUSHING", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK"];
const ACTIVE_DEPLOYMENT_STATUSES = ["QUEUED", "BUILDING", "PUSHING", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "ROLLING_BACK", "DESTROYING", "DESTROY_FAILED"];

async function updateProjectStatusForDeployment({ deploymentId, projectId, workerJobId, status, deploymentTarget }) {
  return prisma.$transaction(async (tx) => {
    const lockKey = `skyforge:project-deployments:${projectId}`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text AS acquired`;
    const owned = await tx.deployment.findFirst({ where: { id: deploymentId, workerJobId }, select: { id: true } });
    if (!owned) return false;
    const newer = await tx.deployment.findFirst({
      where: { projectId, id: { not: deploymentId }, status: { in: ACTIVE_DEPLOYMENT_STATUSES } },
      select: { id: true },
    });
    if (newer) return false;
    await tx.project.update({ where: { id: projectId }, data: { status, ...(deploymentTarget ? { deploymentTarget } : {}) } });
    return true;
  }, { timeout: 15_000 });
}

function runtimeProjectFor(project, target) {
  const framework = String(project.framework || "").toLowerCase();
  if (target === "AWS_ECS_FARGATE") {
    if (!project.dockerized && (framework.includes("react") || framework.includes("vite") || framework.includes("vue") || framework.includes("svelte"))) {
      return { ...project, port: 80 };
    }
    if (project.name === "ecommerce-k8s" || framework.includes("generic")) {
      return { ...project, port: 80 };
    }
  }
  return project;
}

function targetFor(project, requestedTarget) {
  const value = String(requestedTarget || project.deploymentTarget || "").toUpperCase();
  return value.includes("S3") || value.includes("CLOUDFRONT") || value === "STATIC"
    ? "AWS_S3_CLOUDFRONT"
    : "AWS_ECS_FARGATE";
}

async function credentialsFor(userId) {
  const connectionRecord = await prisma.awsConnection.findUnique({ where: { userId } });
  if (connectionRecord) {
    const credentials = await getAwsCredentials(connectionRecord);
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
  throw new Error("No AWS connection is configured for this user.");
}

function staleWorkerError() {
  const error = new Error("This deployment run was superseded by a newer worker job.");
  error.code = "DEPLOYMENT_SUPERSEDED";
  return error;
}

async function updateStage(deploymentId, workerJobId, data) {
  const result = await prisma.deployment.updateMany({
    where: { id: deploymentId, workerJobId },
    data,
  });
  if (result.count !== 1) throw staleWorkerError();
  return result;
}

async function assertNotCancelled(deploymentId, workerJobId) {
  const deployment = await prisma.deployment.findFirst({
    where: { id: deploymentId, workerJobId },
    select: { status: true },
  });
  if (!deployment) throw staleWorkerError();
  if (["CANCELLED", "DESTROYING", "DESTROYED"].includes(deployment.status)) {
    const error = new Error("Deployment was cancelled or destroyed before the operation completed.");
    error.code = "DEPLOYMENT_CANCELLED";
    throw error;
  }
}

export async function processDeploymentJob(job) {
  const { deploymentId, projectId, userId, target: requestedTarget, resumeStep } = job.data;
  const workerJobId = String(job.id || "");
  let activeStep = resumeStep || "CLONING";
  let resources = null;
  let artifactPath = null;
  let deploymentCredentials = null;
  let previousDeployment = null;
  let attemptedTarget = null;

  try {
    if (!workerJobId) throw staleWorkerError();
    const candidate = await prisma.deployment.findFirst({
      where: { id: deploymentId, projectId, project: { userId } },
      select: { status: true, workerJobId: true, configVersion: true, resources: true },
    });
    let leasedDeployment = candidate?.workerJobId === workerJobId ? candidate : null;
    if (!leasedDeployment && candidate?.workerJobId === null && RUNNABLE_DEPLOYMENT_STATUSES.includes(candidate.status)) {
      const claimed = await prisma.deployment.updateMany({
        where: { id: deploymentId, projectId, project: { userId }, workerJobId: null, status: candidate.status },
        data: { workerJobId },
      });
      if (claimed.count === 1) leasedDeployment = { ...candidate, workerJobId };
    }
    if (!leasedDeployment) throw staleWorkerError();
    resources = candidate.resources || null;
    if (!RUNNABLE_DEPLOYMENT_STATUSES.includes(leasedDeployment.status)) {
      const error = new Error(`Deployment cannot start from ${leasedDeployment.status}.`);
      error.code = leasedDeployment.status === "CANCELLED" ? "DEPLOYMENT_CANCELLED" : "DEPLOYMENT_SUPERSEDED";
      throw error;
    }

    const project = await prisma.project.findFirst({ where: { id: projectId, userId: job.data.userId } });
    if (!project) throw new Error("Project no longer exists.");
    if (candidate.configVersion !== null && candidate.configVersion !== undefined && project.configVersion !== candidate.configVersion) {
      const error = new Error("Project configuration changed after this deployment was queued. Generate a new deployment attempt.");
      error.code = "DEPLOYMENT_CONFIG_CHANGED";
      throw error;
    }
    const target = targetFor(project, requestedTarget);
    attemptedTarget = target;
    const runtimeProject = runtimeProjectFor(project, target);
    const credentials = await credentialsFor(project.userId);
    deploymentCredentials = credentials;
    const previous = await prisma.deployment.findFirst({
      where: { projectId, status: { in: ["LIVE", "ROLLED_BACK"] }, resources: { not: Prisma.AnyNull } },
      orderBy: { createdAt: "desc" },
      select: { resources: true },
    });
    previousDeployment = previous;
    const persistResources = async (partialResources) => {
      if (!partialResources || typeof partialResources !== "object") return;
      resources = { ...(resources || {}), ...partialResources };
      const checkpoint = await prisma.deployment.updateMany({
        where: { id: deploymentId, workerJobId },
        data: { resources },
      });
      if (checkpoint.count !== 1) throw staleWorkerError();
    };

    if (!await updateProjectStatusForDeployment({ deploymentId, projectId, workerJobId, status: "Deploying" })) {
      throw staleWorkerError();
    }
    await updateStage(deploymentId, workerJobId, {
      status: "BUILDING",
      stage: "CLONING",
      currentStep: "CLONING",
      target,
      startedAt: new Date(),
      completedAt: null,
      error: null,
      resources: resources ?? Prisma.DbNull,
    });
    if (resumeStep) emitDeploymentLog(deploymentId, { stage: "CLONING", message: `[RETRY] Re-running the verified pipeline from ${resumeStep}.`, level: "warn" });

    const sourceDir = await prepareRepository(project, deploymentId);
    await assertNotCancelled(deploymentId, workerJobId);
    activeStep = "BUILDING";
    await updateStage(deploymentId, workerJobId, { status: "BUILDING", stage: "BUILDING", currentStep: "BUILDING" });

    let deployResult;
    if (target === "AWS_S3_CLOUDFRONT") {
      emitDeploymentLog(deploymentId, { stage: "PUSHING", message: "[PUSH] Static target does not require a container registry.", level: "info" });
      const outputDir = await buildStaticAssets(project, deploymentId, sourceDir);
      await assertNotCancelled(deploymentId, workerJobId);
      artifactPath = outputDir;
      await updateStage(deploymentId, workerJobId, { artifactPath, stage: "PROVISIONING", currentStep: "PROVISIONING", status: "PROVISIONING" });
      emitDeploymentLog(deploymentId, { stage: "PROVISIONING", message: "[CLOUDFRONT] Preparing private S3 origin and Origin Access Control.", level: "info" });
      await updateStage(deploymentId, workerJobId, { stage: "DEPLOYING", currentStep: "DEPLOYING", status: "DEPLOYING" });
      deployResult = await deployStaticProject({
        deploymentId,
        project,
        credentials,
        outputDir,
        onResources: persistResources,
      });
      await assertNotCancelled(deploymentId, workerJobId);
    } else {
      const imageTag = `skyforge-${String(project.id).toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${String(deploymentId).slice(-8)}`;
      await buildContainerImage(runtimeProject, deploymentId, sourceDir, imageTag);
      await assertNotCancelled(deploymentId, workerJobId);
      activeStep = "PUSHING";
      await updateStage(deploymentId, workerJobId, { status: "PUSHING", stage: "PUSHING", currentStep: "PUSHING" });
      const pushed = await pushImageToEcr(deploymentId, project, credentials, imageTag, persistResources);
      resources = {
        ...(resources || {}),
        type: "ECS_FARGATE",
        repositoryName: pushed.repositoryName,
        registry: pushed.registry,
        imageUri: pushed.ecrUri,
        imageDigest: pushed.imageDigest,
      };
      await updateStage(deploymentId, workerJobId, { resources });
      await assertNotCancelled(deploymentId, workerJobId);
      await updateStage(deploymentId, workerJobId, { status: "PROVISIONING", stage: "PROVISIONING", currentStep: "PROVISIONING" });
      emitDeploymentLog(deploymentId, { stage: "PROVISIONING", message: "[ECS] Provisioning task definition, service, load balancer, and target group.", level: "info" });
      await updateStage(deploymentId, workerJobId, { status: "DEPLOYING", stage: "DEPLOYING", currentStep: "DEPLOYING" });
      deployResult = await deployToEcs({
        deploymentId,
        project: runtimeProject,
        credentials,
        imageUri: pushed.ecrUri,
        onResources: persistResources,
      });
      await assertNotCancelled(deploymentId, workerJobId);
    }

    if (deployResult.resources && typeof deployResult.resources === "object") {
      resources = { ...(resources || {}), ...deployResult.resources };
    } else if (previous?.resources && !resources) {
      resources = previous.resources;
    }
    await updateStage(deploymentId, workerJobId, { resources, artifactPath });

    activeStep = "HEALTH_CHECK";
    await updateStage(deploymentId, workerJobId, { status: "HEALTH_CHECK", stage: "HEALTH_CHECK", currentStep: "HEALTH_CHECK" });
    const healthPath = typeof project.healthCheck === "string" && /^\/[A-Za-z0-9/_-]*$/.test(project.healthCheck) ? project.healthCheck : "/";
    const health = await probeEndpoint(deployResult.endpoint, {
      attempts: 8,
      timeoutMs: 10_000,
      ...(target === "AWS_ECS_FARGATE" ? { path: healthPath } : {}),
    });
    emitDeploymentLog(deploymentId, { stage: "HEALTH_CHECK", message: `[HEALTH] ${health.endpoint} returned HTTP ${health.status} in ${health.latencyMs}ms.`, level: "success" });

    activeStep = "LIVE";
    await updateStage(deploymentId, workerJobId, {
      status: "LIVE",
      stage: "COMPLETE",
      currentStep: "LIVE",
      liveUrl: deployResult.endpoint,
      healthStatus: "HEALTHY",
      latencyMs: health.latencyMs,
      target: deployResult.type,
      resources,
      artifactPath,
      completedAt: new Date(),
      error: null,
    });
    try {
      const updated = await updateProjectStatusForDeployment({ deploymentId, projectId, workerJobId, status: "Live", deploymentTarget: target });
      if (!updated) console.warn(`[WORKER] Deployment ${deploymentId} is live but a newer project operation owns the project status.`);
    } catch (projectError) {
      console.error(`[WORKER] Deployment ${deploymentId} is live but project status update failed:`, projectError.message);
    }
    emitDeploymentLog(deploymentId, { stage: "LIVE", message: `[LIVE] Application is live at ${deployResult.endpoint}`, level: "success" });
    try {
      await persistDeploymentLogs(deploymentId, getDeploymentLogs(deploymentId));
    } catch (logsError) {
      console.warn(`[WORKER] Deployment ${deploymentId} is live but log persistence failed: ${logsError.message}`);
    }

    try {
      await addMonitorJob({ deploymentId, projectId, liveUrl: deployResult.endpoint, target: deployResult.type }, { jobId: `monitor-${deploymentId}-${Math.floor(Date.now() / 60_000) + 1}` });
    } catch (monitorError) {
      console.warn(`[MONITOR] Initial check not queued: ${monitorError.message}`);
    }
    return deployResult;
  } catch (error) {
    if (error?.resources && typeof error.resources === "object") {
      resources = { ...(resources || {}), ...error.resources };
    }
    if (error.code === "DEPLOYMENT_SUPERSEDED") {
      console.warn(`[WORKER] Ignoring stale deployment job ${workerJobId || "unknown"} for ${deploymentId}.`);
      throw error;
    }
    if (
      attemptedTarget === "AWS_ECS_FARGATE"
      && deploymentCredentials
      && resources?.clusterName
      && resources?.serviceName
      && resources?.taskDefinitionArn
      && previousDeployment?.resources?.taskDefinitionArn
      && previousDeployment.resources.clusterName === resources.clusterName
      && previousDeployment.resources.serviceName === resources.serviceName
    ) {
      try {
        await rollbackEcs({
          credentials: deploymentCredentials,
          resources,
          previousTaskDefinitionArn: previousDeployment.resources.taskDefinitionArn,
        });
        emitDeploymentLog(deploymentId, { stage: "FAILED", message: "[RECOVERY] Restored the previously live ECS task definition after the failed rollout.", level: "warn" });
      } catch (recoveryError) {
        console.error(`[WORKER] ECS compensation failed for ${deploymentId}:`, recoveryError);
        emitDeploymentLog(deploymentId, { stage: "FAILED", message: `[RECOVERY] Previous ECS revision could not be restored: ${recoveryError.message}`, level: "error" });
      }
    }
    if (
      attemptedTarget === "AWS_S3_CLOUDFRONT"
      && deploymentCredentials
      && resources?.distributionId
      && previousDeployment?.resources?.type === "S3_CLOUDFRONT"
      && previousDeployment.resources.distributionId === resources.distributionId
    ) {
      try {
        await rollbackStaticDistribution({ credentials: deploymentCredentials, resources, previousResources: previousDeployment.resources });
        emitDeploymentLog(deploymentId, { stage: "FAILED", message: "[RECOVERY] Restored the previously live static release after the failed rollout.", level: "warn" });
      } catch (recoveryError) {
        console.error(`[WORKER] Static compensation failed for ${deploymentId}:`, recoveryError);
        emitDeploymentLog(deploymentId, { stage: "FAILED", message: `[RECOVERY] Previous static release could not be restored: ${recoveryError.message}`, level: "error" });
      }
    }
    console.error(`[WORKER] Deployment ${deploymentId} failed at ${activeStep}:`, error);
    await updateProjectStatusForDeployment({
      deploymentId,
      projectId,
      workerJobId,
      status: error.code === "DEPLOYMENT_CANCELLED" ? "Ready to Deploy" : "Deployment Failed",
    }).catch(() => {});
    emitDeploymentLog(deploymentId, { stage: "FAILED", message: `[ERROR] ${activeStep} failed: ${error.message}`, level: "error" });
    emitDeploymentLog(deploymentId, { stage: "FAILED", message: "[ERROR] Deployment stopped; any cloud promotion is being compensated or requires teardown.", level: "warn" });
    await updateStage(deploymentId, workerJobId, {
      status: error.code === "DEPLOYMENT_CANCELLED" ? "CANCELLED" : "FAILED",
      stage: error.code === "DEPLOYMENT_CANCELLED" ? "CANCELLED" : "FAILED",
      currentStep: activeStep,
      error: String(error.message).slice(0, 2000),
      resources,
      artifactPath,
      completedAt: new Date(),
    }).catch(() => {});
    throw error;
  }
}

let deploymentWorker = null;
if (process.env.START_WORKERS === "true") {
  deploymentWorker = new Worker("deployments", processDeploymentJob, { connection, concurrency: Number.parseInt(process.env.DEPLOYMENT_WORKER_CONCURRENCY || "1", 10) });
  deploymentWorker.on("completed", (job) => console.log(`[WORKER:deployments] Job ${job.id} completed.`));
  deploymentWorker.on("failed", (job, error) => console.error(`[WORKER:deployments] Job ${job?.id} failed: ${error.message}`));
  deploymentWorker.on("error", (error) => console.warn(`[WORKER:deployments] ${error.message}`));
}

export async function closeDeploymentWorker() {
  if (deploymentWorker) await deploymentWorker.close();
}

export default deploymentWorker;
