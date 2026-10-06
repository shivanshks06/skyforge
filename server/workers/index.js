import "../config/env.js";

process.env.START_WORKERS = "true";

if (process.env.NODE_ENV === "production") {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required in production.");
  if (!process.env.REDIS_URL && (!process.env.REDIS_HOST || !process.env.REDIS_PORT)) throw new Error("REDIS_URL or REDIS_HOST/REDIS_PORT is required in production.");
  if (!process.env.FIELD_ENCRYPTION_KEY) throw new Error("FIELD_ENCRYPTION_KEY is required in production.");
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error("JWT_SECRET must be configured with at least 32 characters in production.");
  if (process.env.ALLOW_INLINE_JOBS === "true") throw new Error("ALLOW_INLINE_JOBS must remain false in production.");
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

// Restart health monitoring (and offline/resume handling) for every live site.
try {
  const { default: prisma } = await import("../config/db.js");
  const { ensureMonitoringFor } = await import("../queues/monitorQueue.js");
  const live = await prisma.deployment.findMany({ where: { status: { in: ["LIVE", "ROLLED_BACK"] } }, orderBy: { createdAt: "desc" }, select: { id: true, projectId: true, liveUrl: true } });
  const newestPerProject = [...new Map(live.map((deployment) => [deployment.projectId, deployment])).values()];
  const seeded = await ensureMonitoringFor(newestPerProject.reverse());
  if (seeded) console.log(`[WORKERS] Resumed monitoring for ${seeded} live site(s).`);
} catch (error) {
  console.warn(`[WORKERS] Could not resume monitoring: ${error.message}`);
}

// Auto-deploy on push and pull-request previews.
const { startGitWatcher } = await import("../services/gitWatcher.js");
const stopGitWatcher = startGitWatcher();

// Monthly AWS budget: compare spend with each person's budget every 6 hours (Cost Explorer is cached for 6 hours).
const budgetTimer = setInterval(async () => {
  try {
    const [{ default: prisma }, { checkBudget }, { getAwsCredentials }] = await Promise.all([
      import("../config/db.js"), import("../services/costService.js"), import("../services/awsConnectionService.js"),
    ]);
    const users = await prisma.user.findMany({ where: { budget: { not: null } }, select: { id: true, awsConnection: true } });
    for (const user of users) {
      if (!user.awsConnection) continue;
      const credentials = await getAwsCredentials(user.awsConnection).catch(() => null);
      if (credentials?.accessKeyId) await checkBudget(user.id, credentials).catch((error) => console.warn(`[BUDGET] ${error.message}`));
    }
  } catch (error) {
    console.warn(`[BUDGET] ${error.message}`);
  }
}, 6 * 60 * 60_000);
budgetTimer.unref?.();

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
  stopGitWatcher();
  clearInterval(budgetTimer);
  console.log(`[WORKERS] Received ${signal}; closing workers...`);
  await Promise.allSettled([closeDeploymentWorker(), closeRollbackWorker(), closeMonitorWorker(), closeDestroyWorker()]);
  redis.disconnect();
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
console.log("[WORKERS] SkyForge deployment workers started.");
