import { Queue } from "bullmq";
import connection, { getRedisStatus } from "../redis/connection.js";
import { QueueUnavailableError } from "./deploymentQueue.js";

export const destroyQueue = new Queue("destroys", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

let destroyQueueErrorLogged = false;
destroyQueue.on("error", (error) => {
  if (!destroyQueueErrorLogged && (process.env.NODE_ENV === "production" || process.env.LOG_REDIS_ERRORS === "true")) {
    console.warn(`[QUEUE:destroys] ${error.message || error}`);
    destroyQueueErrorLogged = true;
  }
});

export async function addDestroyJob(data, options = {}) {
  const jobId = options.jobId || `destroy-${data.deploymentId}-${Date.now()}`;
  if (getRedisStatus().connected) {
    const job = await destroyQueue.add("execute-destroy", data, { ...options, jobId });
    return { jobId: job.id, queued: true, mode: "BULLMQ_REDIS" };
  }
  if (process.env.ALLOW_INLINE_JOBS === "true" && process.env.NODE_ENV !== "production") {
    setTimeout(async () => {
      try {
        const { processDestroyJob } = await import("../workers/destroyWorker.js");
        await processDestroyJob({ id: jobId, data });
      } catch (error) {
        console.error("[INLINE DESTROY] Execution error:", error);
      }
    }, 100);
    return { jobId, queued: true, mode: "INLINE_DEVELOPMENT_FALLBACK" };
  }
  throw new QueueUnavailableError("Redis is not ready; infrastructure teardown was not accepted.");
}

export default destroyQueue;
