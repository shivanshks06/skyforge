import { Queue } from "bullmq";
import connection, { getRedisStatus } from "../redis/connection.js";
import { QueueUnavailableError } from "./deploymentQueue.js";

export const rollbackQueue = new Queue("rollbacks", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "fixed", delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

let rollbackQueueErrorLogged = false;
rollbackQueue.on("error", (error) => {
  if (!rollbackQueueErrorLogged && (process.env.NODE_ENV === "production" || process.env.LOG_REDIS_ERRORS === "true")) {
    console.warn(`[QUEUE:rollbacks] ${error.message || error}`);
    rollbackQueueErrorLogged = true;
  }
});

export async function addRollbackJob(data, options = {}) {
  const jobId = options.jobId || `rollback-${data.deploymentId}-${Date.now()}`;
  if (getRedisStatus().connected) {
    const job = await rollbackQueue.add("execute-rollback", data, { ...options, jobId });
    return { jobId: job.id, queued: true, mode: "BULLMQ_REDIS" };
  }
  if (process.env.ALLOW_INLINE_JOBS === "true" && process.env.NODE_ENV !== "production") {
    setTimeout(async () => {
      try {
        const { processRollbackJob } = await import("../workers/rollbackWorker.js");
        await processRollbackJob({ id: jobId, data });
      } catch (error) {
        console.error("[INLINE ROLLBACK] Execution error:", error);
      }
    }, 100);
    return { jobId, queued: true, mode: "INLINE_DEVELOPMENT_FALLBACK" };
  }
  throw new QueueUnavailableError("Redis is not ready; rollback was not accepted.");
}

export default rollbackQueue;
