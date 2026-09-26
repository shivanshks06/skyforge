import prisma from "../config/db.js";
import { getRedisStatus } from "../redis/connection.js";
import { deploymentQueue } from "../queues/deploymentQueue.js";
import { rollbackQueue } from "../queues/rollbackQueue.js";
import { destroyQueue } from "../queues/destroyQueue.js";

const ACTIVE_DEPLOYMENT_STATUSES = ["QUEUED", "BUILDING", "PUSHING", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK"];

async function jobState(queue, jobId) {
  if (!jobId) return null;
  const job = await queue.getJob(jobId).catch(() => null);
  if (!job) return "missing";
  return job.getState().catch(() => "missing");
}

export async function reconcilePersistedOperations() {
  if (!getRedisStatus().connected) return;
  const deployments = await prisma.deployment.findMany({
    where: {
      OR: [
        { status: { in: ACTIVE_DEPLOYMENT_STATUSES } },
        { status: "ROLLING_BACK" },
        { status: "DESTROYING" },
      ],
    },
    select: {
      id: true, projectId: true, status: true, workerJobId: true, target: true, rollbackOriginalStatus: true,
      project: { select: { userId: true } }, retryOfId: true,
    },
  });

  for (const deployment of deployments) {
    const state = deployment.status === "ROLLING_BACK"
      ? await jobState(rollbackQueue, deployment.workerJobId)
      : deployment.status === "DESTROYING"
        ? await jobState(destroyQueue, deployment.workerJobId)
        : await jobState(deploymentQueue, deployment.workerJobId);

    if (["waiting", "delayed", "active", "waiting-children", "prioritized"].includes(state)) continue;
    if (deployment.status === "DESTROYING") {
      await prisma.deployment.updateMany({
        where: { id: deployment.id, workerJobId: deployment.workerJobId, status: "DESTROYING" },
        data: { status: "DESTROY_FAILED", stage: "DESTROY_FAILED", currentStep: "DESTROY", workerJobId: null, error: "Teardown job was lost before completion.", completedAt: new Date() },
      }).catch(() => {});
      await prisma.project.updateMany({ where: { id: deployment.projectId }, data: { status: "Teardown Failed" } }).catch(() => {});
      continue;
    }
    if (deployment.status === "ROLLING_BACK") {
      const restoredStatus = deployment.rollbackOriginalStatus === "ROLLED_BACK" ? "ROLLED_BACK" : "LIVE";
      await prisma.deployment.updateMany({
        where: { id: deployment.id, workerJobId: deployment.workerJobId, status: "ROLLING_BACK" },
        data: { status: restoredStatus, stage: "COMPLETE", currentStep: restoredStatus, workerJobId: null, rollbackOriginalStatus: null, error: "Rollback job was lost before completion.", completedAt: new Date() },
      }).catch(() => {});
      continue;
    }
    if (deployment.status === "QUEUED" && state === "missing" && deployment.workerJobId) {
      // The database commit and enqueue are separate systems. Reconstruct the
      // exact queued job once; later active states fail closed rather than
      // replaying an unknown AWS operation.
      await deploymentQueue.add("execute-deployment", {
        deploymentId: deployment.id,
        projectId: deployment.projectId,
        userId: deployment.project.userId,
        target: deployment.target,
      }, { jobId: deployment.workerJobId }).catch(() => null);
      continue;
    }
    await prisma.deployment.updateMany({
      where: { id: deployment.id, workerJobId: deployment.workerJobId, status: { in: ACTIVE_DEPLOYMENT_STATUSES } },
      data: { status: "FAILED", stage: "FAILED", currentStep: "FAILED", error: "Deployment job was lost before completion.", completedAt: new Date() },
    }).catch(() => {});
    await prisma.project.updateMany({ where: { id: deployment.projectId }, data: { status: "Deployment Failed" } }).catch(() => {});
  }
}
