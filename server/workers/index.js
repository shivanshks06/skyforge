process.env.START_WORKERS = "true";

if (process.env.NODE_ENV === "production") {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required in production.");
  if (!process.env.REDIS_URL && (!process.env.REDIS_HOST || !process.env.REDIS_PORT)) throw new Error("REDIS_URL or REDIS_HOST/REDIS_PORT is required in production.");
  if (!process.env.FIELD_ENCRYPTION_KEY) throw new Error("FIELD_ENCRYPTION_KEY is required in production.");
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error("JWT_SECRET must be configured with at least 32 characters in production.");
  if (process.env.ALLOW_HOST_BUILDS === "true" || process.env.ALLOW_INLINE_JOBS === "true") throw new Error("Development build and inline-job flags must remain false in production.");
}

const [{ closeDeploymentWorker }, { closeRollbackWorker }, { closeMonitorWorker }, { closeDestroyWorker }, { default: redis }, { reconcilePersistedOperations }] = await Promise.all([
  import("./deploymentWorker.js"),
  import("./rollbackWorker.js"),
  import("./monitorWorker.js"),
  import("./destroyWorker.js"),
  import("../redis/connection.js"),
  import("./reconciler.js"),
]);

const reconciliationTimer = setInterval(() => {
  reconcilePersistedOperations().catch((error) => console.warn(`[RECONCILER] ${error.message}`));
}, 30_000);
reconciliationTimer.unref?.();
await reconcilePersistedOperations().catch((error) => console.warn(`[RECONCILER] ${error.message}`));

const heartbeat = setInterval(() => {
  redis.set("skyforge:worker:heartbeat", String(Date.now()), "EX", 45).catch(() => {});
}, 10_000);
await redis.set("skyforge:worker:heartbeat", String(Date.now()), "EX", 45).catch(() => {});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  clearInterval(reconciliationTimer);
  console.log(`[WORKERS] Received ${signal}; closing workers...`);
  await Promise.allSettled([closeDeploymentWorker(), closeRollbackWorker(), closeMonitorWorker(), closeDestroyWorker()]);
  redis.disconnect();
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
console.log("[WORKERS] SkyForge deployment workers started.");
