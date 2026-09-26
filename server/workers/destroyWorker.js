import { Worker } from "bullmq";
import connection from "../redis/connection.js";
import { destroyProjectInfrastructure } from "../services/destroyService.js";

export async function processDestroyJob(job) {
  return destroyProjectInfrastructure({ ...job.data, jobId: String(job.id || "") });
}

let destroyWorker = null;
if (process.env.START_WORKERS === "true") {
  destroyWorker = new Worker("destroys", processDestroyJob, { connection, concurrency: 1 });
  destroyWorker.on("completed", (job) => console.log(`[WORKER:destroys] Job ${job.id} completed.`));
  destroyWorker.on("failed", (job, error) => console.error(`[WORKER:destroys] Job ${job?.id} failed: ${error.message}`));
  destroyWorker.on("error", (error) => console.warn(`[WORKER:destroys] ${error.message}`));
}

export async function closeDestroyWorker() {
  if (destroyWorker) await destroyWorker.close();
}

export default destroyWorker;
