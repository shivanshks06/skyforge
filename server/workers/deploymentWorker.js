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
import { prepareRepository, buildContainerImage, buildStaticSite } from "../services/sourceService.js";
import { deployStaticProject, rollbackStaticDistribution } from "../services/staticDeployer.js";
import { ensureHttpsEdge } from "../services/cloudfrontEdgeService.js";
import { TARGETS, normalizeTarget } from "../services/targets.js";

const CLOUDFRONT_HELP = "HTTPS switches on automatically once AWS enables CloudFront for the account (AWS Support: \"Account verification for CloudFront\").";
import { pushImageToEcr } from "../services/ecrService.js";
import { runCloudBuild } from "../services/cloudBuildService.js";
import { deployToEcs, rollbackEcs, loadBalancerTargetsHealthy, projectNetwork, resourceNames } from "../services/ecsService.js";
import { probeEndpoint, waitForDnsResolution } from "../services/healthService.js";
import { addMonitorJob } from "../queues/monitorQueue.js";
import { scanDirectory, localhostWarnings } from "../services/envScanner.js";
import { findAppRoot } from "../services/buildPlanner.js";
import { collectSourceFiles } from "../services/envScanner.js";
import { prepareCanary, applyProtection, buildSecurityReport, patchProtection } from "../services/securityService.js";
import { decryptObjectValues, encryptObjectValues } from "../services/secretService.js";
import { usesManagedDatabase, managedDatabaseKeys, ensureManagedDatabase, databaseEnvironment, restrictDatabaseToApp } from "../services/rdsService.js";
import { collectProjectSource, analyzeSource, codeGate, imageGate, hardeningFor, syncCodePermissions, refreshProject } from "../services/deploySecurity.js";
import { runSecurityAutomation } from "../services/securityAutomation.js";
import { headCommit } from "../services/gitWatcher.js";
import { reattachCustomDomain } from "../services/domainService.js";

/** Saves which commit is being deployed (for the history page) unless the trigger already knew it. */
async function recordCommit(deploymentId, project) {
  try {
    const existing = await prisma.deployment.findUnique({ where: { id: deploymentId }, select: { commitSha: true } });
    if (existing?.commitSha) return;
    const commit = await headCommit(project);
    if (!commit) return;
    await prisma.deployment.update({ where: { id: deploymentId }, data: { commitSha: commit.sha, commitMessage: commit.message, commitAuthor: commit.author } });
    emitDeploymentLog(deploymentId, { stage: "CLONING", message: `[SOURCE] Deploying commit ${commit.sha.slice(0, 7)}: ${commit.message.split(/\r?\n/)[0].slice(0, 120)}`, level: "info" });
  } catch {
    // Commit details are informational; GitHub being slow must not stop a deployment.
  }
}

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

// Re-scans the source actually being deployed and stops before the (slow) build when a required
// variable is missing, instead of letting the container crash-loop on AWS.
async function verifyEnvironment(project, sourceDir, deploymentId, { staticSite = false, providedKeys = [] } = {}) {
  let scan;
  try {
    scan = scanDirectory(findAppRoot(sourceDir));
  } catch (error) {
    emitDeploymentLog(deploymentId, { stage: "CLONING", message: `[ENV] Environment scan skipped: ${error.message}`, level: "warn" });
    return;
  }
  const ignored = (project.envAnalysis?.ignored || []).filter((name) => scan.variables.some((variable) => variable.name === name));
  const requiredEnv = scan.variables.filter((variable) => variable.required).map((variable) => variable.name);
  await prisma.project.update({ where: { id: project.id }, data: { envAnalysis: { ...scan, ignored }, requiredEnv } }).catch(() => {});

  const configured = decryptObjectValues(project.envConfig || {});
  const log = (message, level = "info") => emitDeploymentLog(deploymentId, { stage: "CLONING", message, level });
  for (const service of scan.services) {
    if (service.id === "sqlite") log("[ENV] This app uses SQLite: data is stored inside the container and is reset on every deployment.", "warn");
    else log(`[ENV] This app uses ${service.label} (${service.evidence.join(", ")}); it needs a hosted instance reachable from AWS${service.envVars.length ? ` via ${service.envVars.join(", ")}` : service.envHint ? `, usually configured as ${service.envHint}` : ""}.`, "warn");
  }
  for (const name of localhostWarnings(configured).filter((key) => !providedKeys.includes(key))) log(`[ENV] ${name} points to localhost, which is the container itself on AWS; the app will not reach that service.`, "warn");

  // Static sites run no server code, so only build-time values (always optional) could matter.
  if (staticSite) return;
  const missing = scan.variables.filter((variable) => variable.required && !ignored.includes(variable.name) && !providedKeys.includes(variable.name)
    && String(configured[variable.name] ?? "").trim() === "");
  if (!missing.length) {
    if (requiredEnv.length) log(`[ENV] All ${requiredEnv.length} required environment variable(s) are configured.`, "success");
    return;
  }
  for (const variable of missing) log(`[ENV] Missing required variable ${variable.name} (used in ${variable.locations.join(", ")}).`, "error");
  const error = new Error(`Missing required environment variables: ${missing.map((variable) => variable.name).join(", ")}. Set them on the Environment page (or mark them as not needed) and deploy again.`);
  error.code = "MISSING_ENVIRONMENT";
  throw error;
}

/**
 * Post-launch security work. Never fails the deployment: the site is already live, so problems
 * are logged as warnings.
 */
async function secureLiveDeployment(options) {
  // Teardown waits while this marker is set, so it never races the firewall or scan setup.
  await setSecuringMarker(options.project.id, new Date().toISOString());
  try {
    await secureLiveDeploymentSteps(options);
  } finally {
    await setSecuringMarker(options.project.id, null);
  }
}

async function setSecuringMarker(projectId, value) {
  await patchProtection(projectId, { securingSince: value }).catch(() => {});
}

async function stillLive(deploymentId) {
  const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId }, select: { status: true } });
  return deployment?.status === "LIVE";
}

async function secureLiveDeploymentSteps({ project, credentials, deploymentId, resources, liveUrl, imageDigest, sourceDir, target }) {
  const log = (message, level = "info") => emitDeploymentLog(deploymentId, { stage: "LIVE", message, level });
  await prisma.project.update({ where: { id: project.id }, data: { siteOffline: false } }).catch(() => {});
  const sourceFiles = collectProjectSource(sourceDir);
  try {
    if (!(await stillLive(deploymentId))) return;
    const fresh = await prisma.project.findUnique({ where: { id: project.id } });
    const firewall = await applyProtection({ project: fresh, credentials, resources, sourceFiles, log, target });
    const merged = { ...(resources || {}), ...Object.fromEntries(Object.entries(firewall).filter(([, value]) => value)) };
    for (const key of Object.keys(firewall)) if (!firewall[key]) delete merged[key];
    await prisma.deployment.update({ where: { id: deploymentId }, data: { resources: merged } });
  } catch (error) {
    log(`[SECURITY] Firewall could not be applied: ${error.name || "error"}: ${String(error.message).slice(0, 160)}`, "warn");
  }
  try {
    const fresh = await prisma.project.findUnique({ where: { id: project.id } });
    await buildSecurityReport({ project: fresh, credentials, liveUrl, imageDigest, sourceFiles, log });
  } catch (error) {
    log(`[SECURITY] Security scan could not complete: ${String(error.message).slice(0, 160)}`, "warn");
  }
}

function staleWorkerError() {
  const error = new Error("This deployment run was superseded by a newer worker job.");
  error.code = "DEPLOYMENT_SUPERSEDED";
  return error;
}

// When each stage started, per running deployment; saved with the deployment so the console can show step durations.
const stageTimings = new Map();

async function updateStage(deploymentId, workerJobId, data) {
  let payload = data;
  if (data.stage) {
    const list = stageTimings.get(deploymentId) || [];
    if (list.at(-1)?.stage !== data.stage) list.push({ stage: data.stage, at: new Date().toISOString() });
    stageTimings.set(deploymentId, list);
    payload = { ...data, stageTimings: list };
    if (["COMPLETE", "FAILED", "CANCELLED"].includes(data.stage)) stageTimings.delete(deploymentId);
  }
  const result = await prisma.deployment.updateMany({
    where: { id: deploymentId, workerJobId },
    data: payload,
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
  const { deploymentId, projectId, userId, resumeStep } = job.data;
  const workerJobId = String(job.id || "");
  let activeStep = resumeStep || "CLONING";
  let resources = null;
  let deploymentCredentials = null;
  let previousDeployment = null;

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
    const target = normalizeTarget(project.deploymentTarget);
    if (!target) {
      const error = new Error("No deployment target has been chosen. Pick ECS Fargate, ECS Fargate + CloudFront, or S3 + CloudFront on the Infrastructure page.");
      error.code = "DEPLOYMENT_CONFIG_CHANGED";
      throw error;
    }
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
    await recordCommit(deploymentId, project);

    const sourceDir = await prepareRepository(project, deploymentId);
    await assertNotCancelled(deploymentId, workerJobId);
    const managedDatabase = usesManagedDatabase(project) && target !== TARGETS.S3_CLOUDFRONT;
    await verifyEnvironment(project, sourceDir, deploymentId, { staticSite: target === TARGETS.S3_CLOUDFRONT, providedKeys: managedDatabase ? managedDatabaseKeys(project.databaseConfig.engine) : [] });
    activeStep = "BUILDING";
    await updateStage(deploymentId, workerJobId, { status: "BUILDING", stage: "BUILDING", currentStep: "BUILDING" });
    // Security gate and code analysis run before anything is built, so nothing unsafe ever ships.
    const sourceFiles = collectProjectSource(sourceDir);
    const securedProject = await refreshProject(project.id) || project;
    await codeGate({ project: securedProject, sourceFiles, deploymentId });
    const analysis = await analyzeSource({ project: securedProject, sourceFiles, deploymentId }).catch((analysisError) => {
      emitDeploymentLog(deploymentId, { stage: "BUILDING", message: `[SECURITY] Code analysis skipped: ${String(analysisError.message).slice(0, 160)}`, level: "warn" });
      return null;
    });

    let deployResult;
    let imageDigest = null;
    if (target === TARGETS.S3_CLOUDFRONT) {
      const outputDir = await buildStaticSite(project, deploymentId, sourceDir);
      await assertNotCancelled(deploymentId, workerJobId);
      activeStep = "DEPLOYING";
      await updateStage(deploymentId, workerJobId, { status: "DEPLOYING", stage: "DEPLOYING", currentStep: "DEPLOYING" });
      deployResult = await deployStaticProject({ deploymentId, project, credentials, outputDir, onResources: persistResources });
      if (deployResult.type === "S3_STATIC_WEBSITE") {
        emitDeploymentLog(deploymentId, { stage: "DEPLOYING", message: `[CLOUDFRONT] CloudFront is unavailable for this AWS account, so the site is served by S3 website hosting over HTTP. ${CLOUDFRONT_HELP}`, level: "warn" });
      }
      await assertNotCancelled(deploymentId, workerJobId);
    } else {
    const imageTag = `skyforge-${String(project.id).toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${String(deploymentId).slice(-8)}`;
    // Cloud builds run in AWS CodeBuild and push from there; only the source archive leaves this machine.
    const cloud = project.buildMode === "cloud" ? {
      build: ({ archivePath, dockerfileName, buildArgs }) => pushImageToEcr(deploymentId, project, credentials, imageTag, persistResources, {
        remoteBuild: ({ remoteImage }) => runCloudBuild({
          credentials, archivePath, dockerfileName, imageUri: remoteImage, buildArgs, deploymentId,
          isCancelled: () => assertNotCancelled(deploymentId, workerJobId).then(() => false, () => true),
        }),
      }),
    } : null;
    if (cloud) emitDeploymentLog(deploymentId, { stage: "BUILDING", message: "[CLOUD BUILD] This project builds in AWS CodeBuild, not on this machine.", level: "info" });
    const built = await buildContainerImage(project, deploymentId, sourceDir, imageTag, { cloud });
    // The build plan decides the listening port from the source (e.g. 80 for nginx-served SPAs).
    const runtimeProject = { ...project, port: built.port || project.port };
    await assertNotCancelled(deploymentId, workerJobId);
    activeStep = "PUSHING";
    await updateStage(deploymentId, workerJobId, { status: "PUSHING", stage: "PUSHING", currentStep: "PUSHING" });
    const pushed = built.pushed || await pushImageToEcr(deploymentId, project, credentials, imageTag, persistResources);
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
    await imageGate({ project: securedProject, credentials, repositoryName: pushed.repositoryName, imageDigest: pushed.imageDigest, deploymentId });
    await assertNotCancelled(deploymentId, workerJobId);
    activeStep = "PROVISIONING";
    await updateStage(deploymentId, workerJobId, { status: "PROVISIONING", stage: "PROVISIONING", currentStep: "PROVISIONING" });
    emitDeploymentLog(deploymentId, { stage: "PROVISIONING", message: "[ECS] Provisioning task definition, service, load balancer, and target group.", level: "info" });
    activeStep = "DEPLOYING";
    await updateStage(deploymentId, workerJobId, { status: "DEPLOYING", stage: "DEPLOYING", currentStep: "DEPLOYING" });
    const securityLog = (message, level = "info") => emitDeploymentLog(deploymentId, { stage: "DEPLOYING", message, level });
    const canary = await prepareCanary({ project, credentials, log: securityLog });
    if (canary.canary) await persistResources({ canaryUserName: canary.canary.userName });
    if (managedDatabase) {
      // Create (first deploy) or reuse the project's private RDS database and hand its address to the app.
      const db = await ensureManagedDatabase({ credentials, project: await refreshProject(project.id), appName: resourceNames(project).appName, network: await projectNetwork(credentials), deploymentId });
      await persistResources({ dbInstanceIdentifier: db.identifier, dbSecurityGroupId: db.securityGroupId });
      runtimeProject.envConfig = { ...(runtimeProject.envConfig || {}), ...encryptObjectValues(databaseEnvironment(db)) };
      runtimeProject.managedDatabase = db;
    }
    const hardening = hardeningFor(securedProject, analysis);
    if (hardening.readOnlyRoot) emitDeploymentLog(deploymentId, { stage: "DEPLOYING", message: "[SECURITY] Tamper-proof mode: the container filesystem is read-only (writable scratch space only in /tmp, /var/tmp, /run, /var/cache/nginx).", level: "info" });
    try {
      deployResult = await deployToEcs({
        deploymentId,
        project: runtimeProject,
        credentials,
        imageUri: pushed.ecrUri,
        onResources: persistResources,
        extraEnvironment: canary.env,
        hardening,
      });
    } catch (hardenedError) {
      if (!hardening.readOnlyRoot || /cancel|superseded/i.test(String(hardenedError.code || hardenedError.message))) throw hardenedError;
      // Some apps write to their own directories; keep the site working and tell the owner.
      emitDeploymentLog(deploymentId, { stage: "DEPLOYING", message: `[SECURITY] The app did not start with a read-only filesystem (${String(hardenedError.message).slice(0, 160)}). Redeploying with a writable filesystem; the outbound firewall stays as configured.`, level: "warn" });
      deployResult = await deployToEcs({
        deploymentId,
        project: runtimeProject,
        credentials,
        imageUri: pushed.ecrUri,
        onResources: persistResources,
        extraEnvironment: canary.env,
        hardening: { ...hardening, readOnlyRoot: false },
      });
    }
    if (runtimeProject.managedDatabase && deployResult.resources?.taskSecurityGroupId) {
      await restrictDatabaseToApp({ credentials, securityGroupId: runtimeProject.managedDatabase.securityGroupId, taskSecurityGroupId: deployResult.resources.taskSecurityGroupId, port: runtimeProject.managedDatabase.port })
        .then(() => emitDeploymentLog(deploymentId, { stage: "DEPLOYING", message: "[DATABASE] Only the app's containers can reach the database.", level: "info" }))
        .catch((dbError) => emitDeploymentLog(deploymentId, { stage: "DEPLOYING", message: `[DATABASE] Could not narrow database access: ${String(dbError.message).slice(0, 160)}`, level: "warn" }));
    }
    await syncCodePermissions({ project: securedProject, credentials, analysis, deploymentId }).catch((permissionError) => {
      emitDeploymentLog(deploymentId, { stage: "DEPLOYING", message: `[IAM] Code-derived permissions not applied: ${String(permissionError.message).slice(0, 160)}`, level: "warn" });
    });
    imageDigest = pushed.imageDigest;
    await assertNotCancelled(deploymentId, workerJobId);
    if (target === TARGETS.ECS_CLOUDFRONT) {
      try {
        const edge = await ensureHttpsEdge({ deploymentId, credentials, loadBalancerDns: deployResult.resources?.loadBalancerDns, onResources: persistResources });
        deployResult = { ...deployResult, endpoint: edge.domainName, resources: { ...deployResult.resources, edgeDistributionId: edge.distributionId, edgeDistributionArn: edge.distributionArn, edgeOriginDomain: edge.originDomain } };
      } catch (edgeError) {
        // The app is already running behind the load balancer; serve it there rather than failing.
        emitDeploymentLog(deploymentId, { stage: "DEPLOYING", message: `[CLOUDFRONT] HTTPS edge unavailable (${String(edgeError.message).slice(0, 160)}). Serving the app over the load balancer (HTTP) instead. ${CLOUDFRONT_HELP}`, level: "warn" });
      }
      await assertNotCancelled(deploymentId, workerJobId);
    }
    }

    if (deployResult.resources && typeof deployResult.resources === "object") {
      resources = { ...(resources || {}), ...deployResult.resources };
    } else if (previous?.resources && !resources) {
      resources = previous.resources;
    }
    await updateStage(deploymentId, workerJobId, { resources });

    activeStep = "HEALTH_CHECK";
    await updateStage(deploymentId, workerJobId, { status: "HEALTH_CHECK", stage: "HEALTH_CHECK", currentStep: "HEALTH_CHECK" });
    const healthPath = target !== TARGETS.S3_CLOUDFRONT && typeof project.healthCheck === "string" && /^\/[A-Za-z0-9/_-]*$/.test(project.healthCheck) ? project.healthCheck : "/";
    await waitForDnsResolution(deployResult.endpoint, {
      onWait: () => emitDeploymentLog(deploymentId, { stage: "HEALTH_CHECK", message: "[HEALTH] Waiting for the new load balancer address to appear in DNS (usually 1-5 minutes)...", level: "info" }),
    });
    let health;
    try {
      health = await probeEndpoint(deployResult.endpoint, { attempts: 20, timeoutMs: 10_000, path: healthPath });
    } catch (probeError) {
      // This machine's network or DNS can lag behind AWS; the load balancer's own health check
      // is authoritative for whether the app is serving.
      const awsHealthy = await loadBalancerTargetsHealthy({ credentials, targetGroupArn: resources?.targetGroupArn }).catch(() => false);
      if (!awsHealthy) throw probeError;
      emitDeploymentLog(deploymentId, { stage: "HEALTH_CHECK", message: `[HEALTH] This machine could not reach the endpoint yet (${probeError.message.slice(0, 120)}), but AWS reports the load balancer target healthy.`, level: "warn" });
      health = { endpoint: deployResult.endpoint, status: "healthy (AWS target health)", latencyMs: null };
    }
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
    await secureLiveDeployment({ project, credentials, deploymentId, resources, liveUrl: deployResult.endpoint, imageDigest, sourceDir, target });
    // A custom domain survives redeploys: make sure the new resources still answer for it.
    await reattachCustomDomain({ projectId, credentials, resources, log: (message, level = "info") => emitDeploymentLog(deploymentId, { stage: "LIVE", message, level }) }).catch((domainError) => {
      emitDeploymentLog(deploymentId, { stage: "LIVE", message: `[DOMAIN] Custom domain could not be re-attached: ${String(domainError.message).slice(0, 160)}`, level: "warn" });
    });
    // Baseline the watchers (known CVEs, latest commit, cost) in the background.
    void runSecurityAutomation({ projectId, credentials, resources, liveUrl: deployResult.endpoint, deploymentId, only: ["cve", "push", "wallet"] }).catch(() => {});
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
      deploymentCredentials
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
      deploymentCredentials
      && resources?.type === "S3_CLOUDFRONT"
      && resources?.distributionId
      && previousDeployment?.resources?.type === "S3_CLOUDFRONT"
      && previousDeployment.resources.distributionId === resources.distributionId
    ) {
      try {
        await rollbackStaticDistribution({ credentials: deploymentCredentials, resources, previousResources: previousDeployment.resources });
        emitDeploymentLog(deploymentId, { stage: "FAILED", message: "[RECOVERY] Restored the previously live static release after the failed rollout.", level: "warn" });
      } catch (recoveryError) {
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
