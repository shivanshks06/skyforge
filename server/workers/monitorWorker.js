import { Worker } from "bullmq";
import connection from "../redis/connection.js";
import prisma from "../config/db.js";
import { emitDeploymentLog } from "../services/logsService.js";
import { probeEndpoint } from "../services/healthService.js";
import { addMonitorJob } from "../queues/monitorQueue.js";
import { getAwsCredentials } from "../services/awsConnectionService.js";
import { routeTrafficToAppWhenHealthy } from "../services/ecsService.js";
import { runSecurityAutomation, recordHealth } from "../services/securityAutomation.js";
import { patchProtection } from "../services/securityService.js";

// One automation run per project at a time; the monitor fires every minute.
const automationRunning = new Set();
function startAutomation({ project, credentials, resources, liveUrl, deploymentId }) {
  if (!credentials || automationRunning.has(project.id)) return;
  automationRunning.add(project.id);
  void runSecurityAutomation({ projectId: project.id, credentials, resources, liveUrl, deploymentId })
    .catch((error) => console.warn(`[MONITOR] Security automation: ${error.message}`))
    .finally(() => automationRunning.delete(project.id));
}

async function projectCredentials(userId) {
  const connection = await prisma.awsConnection.findUnique({ where: { userId } });
  return connection ? getAwsCredentials(connection).catch(() => null) : null;
}

/** Offline/resume handling and security upkeep. Returns true when the health probe should be skipped. */
async function siteMaintenance(deploymentId, project, resources, liveUrl) {
  const credentials = await projectCredentials(project.userId);
  startAutomation({ project, credentials, resources, liveUrl, deploymentId });
  if (project.siteOffline) return true;
  if (project.protection?.resuming && credentials && resources?.targetGroupArn) {
    const switched = await routeTrafficToAppWhenHealthy({ credentials, resources }).catch(() => false);
    if (!switched) return true;
    await patchProtection(project.id, { resuming: false });
    await prisma.project.update({ where: { id: project.id }, data: { status: "Live" } });
    emitDeploymentLog(deploymentId, { stage: "MONITOR", message: "[ONLINE] The container is healthy again; traffic now reaches the site.", level: "success" });
  }
  return false;
}

function nextMonitorJobId(deploymentId) {
  return `monitor-${deploymentId}-${Math.floor(Date.now() / 60_000) + 1}`;
}

export async function processMonitorJob(job) {
  const { deploymentId, liveUrl, target } = job.data;
  try {
    const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId }, select: { status: true, liveUrl: true, projectId: true, resources: true, project: { select: { id: true, name: true, userId: true, healthCheck: true, siteOffline: true, protection: true } } } });
    if (!deployment || !["LIVE", "ROLLED_BACK"].includes(deployment.status)) return;
    const newest = await prisma.deployment.findFirst({ where: { projectId: deployment.projectId, status: { in: ["LIVE", "ROLLED_BACK"] } }, orderBy: { createdAt: "desc" }, select: { id: true } });
    if (newest?.id !== deploymentId) return;

    if (await siteMaintenance(deploymentId, deployment.project, deployment.resources, liveUrl || deployment.liveUrl)) {
      await addMonitorJob({ deploymentId, liveUrl: liveUrl || deployment.liveUrl, target }, { delay: 60_000, jobId: nextMonitorJobId(deploymentId) });
      return { skipped: "site offline or resuming" };
    }

    try {
      const healthPath = typeof deployment.project?.healthCheck === "string" && /^\/[A-Za-z0-9/_-]*$/.test(deployment.project.healthCheck) ? deployment.project.healthCheck : "/";
      const result = await probeEndpoint(liveUrl || deployment.liveUrl, { attempts: 1, timeoutMs: 10_000, ...(target === "ECS_FARGATE" ? { path: healthPath } : {}) });
      await prisma.deployment.update({ where: { id: deploymentId }, data: { healthStatus: "HEALTHY", latencyMs: result.latencyMs, updatedAt: new Date() } });
      await recordHealth({ project: await prisma.project.findUnique({ where: { id: deployment.projectId } }), resources: deployment.resources, deploymentId, healthy: true }).catch(() => {});
      emitDeploymentLog(deploymentId, { stage: "MONITOR", message: `[MONITOR] ${result.endpoint} returned HTTP ${result.status} in ${result.latencyMs}ms.`, level: "info" });
      await addMonitorJob({ deploymentId, liveUrl: liveUrl || deployment.liveUrl, target }, { delay: 60_000, jobId: nextMonitorJobId(deploymentId) });
    } catch (error) {
      await prisma.deployment.update({ where: { id: deploymentId }, data: { healthStatus: "UNHEALTHY" } });
      await recordHealth({ project: await prisma.project.findUnique({ where: { id: deployment.projectId } }), credentials: await projectCredentials(deployment.project.userId), resources: deployment.resources, deploymentId, healthy: false, error: error.message }).catch(() => {});
      emitDeploymentLog(deploymentId, { stage: "MONITOR", message: `[MONITOR] Health probe failed: ${error.message}`, level: "error" });
      await addMonitorJob({ deploymentId, liveUrl: liveUrl || deployment.liveUrl, target }, { delay: 60_000, jobId: nextMonitorJobId(deploymentId) });
    }
    return { checkedAt: new Date().toISOString() };
  } catch (error) {
    console.warn(`[WORKER:monitoring] ${error.message}`);
    throw error;
  }
}

let monitorWorker = null;
if (process.env.START_WORKERS === "true") {
  monitorWorker = new Worker("monitoring", processMonitorJob, { connection, concurrency: 2 });
  monitorWorker.on("error", (error) => console.warn(`[WORKER:monitoring] ${error.message}`));
}

export async function closeMonitorWorker() {
  if (monitorWorker) await monitorWorker.close();
}

export default monitorWorker;
