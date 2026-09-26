import { Queue } from "bullmq";
import connection, { getRedisStatus } from "../redis/connection.js";
import { QueueUnavailableError } from "./deploymentQueue.js";

export const monitorQueue = new Queue("monitoring", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    removeOnComplete: 50,
    removeOnFail: 50,
  },
});

let monitorQueueErrorLogged = false;
monitorQueue.on("error", (error) => {
  if (!monitorQueueErrorLogged && (process.env.NODE_ENV === "production" || process.env.LOG_REDIS_ERRORS === "true")) {
    console.warn(`[QUEUE:monitoring] ${error.message || error}`);
    monitorQueueErrorLogged = true;
  }
});

export async function addMonitorJob(data, options = {}) {
  const jobId = options.jobId || `monitor-${data.deploymentId || "general"}-${Date.now()}`;
  if (getRedisStatus().connected) {
    const job = await monitorQueue.add("check-health", data, { ...options, jobId });
    return { jobId: job.id, queued: true, mode: "BULLMQ_REDIS" };
  }
  if (process.env.ALLOW_INLINE_JOBS === "true" && process.env.NODE_ENV !== "production") {
    const delayMs = Math.max(Number(options.delay) || 60_000, 30_000);
    setTimeout(async () => {
      try {
        const { processMonitorJob } = await import("../workers/monitorWorker.js");
        await processMonitorJob({ id: jobId, data });
      } catch (error) {
        console.error("[INLINE MONITOR] Execution error:", error);
      }
    }, delayMs);
    return { jobId, queued: true, mode: "INLINE_DEVELOPMENT_FALLBACK" };
  }
  throw new QueueUnavailableError("Redis is not ready; monitoring was not accepted.");
}

export default monitorQueue;
