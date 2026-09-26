import { Queue } from "bullmq";
import connection, { getRedisStatus } from "../redis/connection.js";

export class QueueUnavailableError extends Error {
  constructor(message = "Deployment queue is unavailable") {
    super(message);
    this.name = "QueueUnavailableError";
    this.statusCode = 503;
  }
}

export const deploymentQueue = new Queue("deployments", {
  connection,
  defaultJobOptions: {
    attempts: 1,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

let deploymentQueueErrorLogged = false;
deploymentQueue.on("error", (error) => {
  if (!deploymentQueueErrorLogged && (process.env.NODE_ENV === "production" || process.env.LOG_REDIS_ERRORS === "true")) {
    console.warn(`[QUEUE:deployments] ${error.message || error}`);
    deploymentQueueErrorLogged = true;
  }
});

function inlineJobsAllowed() {
  return process.env.ALLOW_INLINE_JOBS === "true" && process.env.NODE_ENV !== "production";
}

export async function addDeploymentJob(data, options = {}) {
  const jobId = options.jobId || `deploy-${data.deploymentId}-${Date.now()}`;
  const status = getRedisStatus();

  if (status.connected) {
    const job = await deploymentQueue.add("execute-deployment", data, {
      ...options,
      jobId,
    });
    return { jobId: job.id, queued: true, mode: "BULLMQ_REDIS" };
  }

  if (!inlineJobsAllowed()) {
    throw new QueueUnavailableError("Redis is not ready; deployment was not accepted.");
  }

  setTimeout(async () => {
    try {
      const { processDeploymentJob } = await import("../workers/deploymentWorker.js");
      await processDeploymentJob({ id: jobId, data });
    } catch (error) {
      console.error("[INLINE DEPLOYMENT] Execution error:", error);
    }
  }, 100);

  return { jobId, queued: true, mode: "INLINE_DEVELOPMENT_FALLBACK" };
}

export async function getQueuePosition(jobId) {
  if (!getRedisStatus().connected) {
    return { position: null, totalWaiting: null, status: "QUEUE_UNAVAILABLE" };
  }

  let job = await deploymentQueue.getJob(jobId);
  if (!job) {
    const candidates = await deploymentQueue.getJobs(["waiting", "delayed", "active", "completed", "failed"]);
    job = candidates.find((entry) => entry.data?.deploymentId === jobId);
  }
  if (!job) return { position: null, totalWaiting: null, status: "NOT_FOUND" };
  const state = await job.getState();
  const waiting = await deploymentQueue.getWaiting();
  const index = waiting.findIndex((entry) => entry.id === jobId);
  return {
    position: index >= 0 ? index + 1 : null,
    totalWaiting: waiting.length,
    status: state.toUpperCase(),
  };
}

export async function removeDeploymentJobs(identifier) {
  if (!getRedisStatus().connected) return;
  const jobs = await deploymentQueue.getJobs(["waiting", "delayed", "active"]);
  await Promise.all(jobs
    .filter((job) => job.data?.deploymentId === identifier || job.data?.projectId === identifier)
    .map((job) => job.remove().catch(() => {})));
}

export default deploymentQueue;
