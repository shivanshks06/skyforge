// Queues a deployment for a project. Shared by the Deploy button, auto-deploy on push, and pull-request previews.
import crypto from "node:crypto";
import prisma from "../config/db.js";
import { addDeploymentJob, removeDeploymentJobs } from "../queues/deploymentQueue.js";
import { getAwsCredentials } from "./awsConnectionService.js";
import { decryptObjectValues } from "./secretService.js";
import { effectiveRequiredEnv } from "./envScanner.js";
import { usesManagedDatabase, managedDatabaseKeys } from "./rdsService.js";
import { normalizeTarget, TARGETS } from "./targets.js";
import { uniqueResources, validateResourceManifests } from "./resourceUtils.js";
import { addDestroyJob } from "../queues/destroyQueue.js";

const SUPERSEDABLE_STATUSES = ["QUEUED", "BUILDING"];
const BLOCKING_STATUSES = ["PUSHING", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "ROLLING_BACK", "DESTROYING"];

export async function lockProjectDeploymentOperations(tx, projectId) {
  const lockKey = `skyforge:project-deployments:${projectId}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text AS acquired`;
}

export async function credentialsForProject(project) {
  const connection = await prisma.awsConnection.findUnique({ where: { userId: project.userId } });
  if (connection) {
    const credentials = await getAwsCredentials(connection);
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
  throw new Error("Connect an AWS account before deploying a project.");
}

export async function preflight(project) {
  const blockers = [];
  let credentials;
  try {
    credentials = await credentialsForProject(project);
  } catch (error) {
    blockers.push(error.message);
  }

  const target = normalizeTarget(project.deploymentTarget);
  if (!target) blockers.push("Choose a deployment target (ECS Fargate, ECS Fargate + CloudFront, or S3 + CloudFront) on the Infrastructure page.");
  if (target === TARGETS.S3_CLOUDFRONT && !/^\d{12}$/.test(credentials?.accountId || "")) blockers.push("The AWS account ID is needed for the S3 bucket name; reconnect AWS.");
  // Static sites have no server, so runtime variables do not apply.
  // A SkyForge-managed database supplies DATABASE_URL and friends itself.
  const managed = usesManagedDatabase(project) ? managedDatabaseKeys(project.databaseConfig.engine) : [];
  const required = target === TARGETS.S3_CLOUDFRONT ? [] : effectiveRequiredEnv(project).filter((key) => !managed.includes(key));
  const configured = decryptObjectValues(project.envConfig || {});
  for (const key of required) {
    if (configured[key] === undefined || configured[key] === null || String(configured[key]).trim() === "") blockers.push(`Environment variable ${key} is not configured.`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project.repoName) || project.repoName.includes("..")) blockers.push("The GitHub repository identity is invalid.");
  if (!/^[\w./-]+$/.test(project.branch || "") || String(project.branch || "").includes("..")) blockers.push("The Git branch name is invalid.");
  if (!credentials?.region) blockers.push("AWS region is not configured.");
  return { blockers };
}

/**
 * Creates a QUEUED deployment (superseding one that has not started pushing yet) and hands it to the worker.
 * `trigger` is "manual", "push" or "preview"; `commit` is optional { sha, message, author } known up front.
 */
export async function queueDeployment(project, { trigger = "manual", commit = null } = {}) {
  const target = normalizeTarget(project.deploymentTarget);
  let superseded = false;
  const { deployment, workerJobId } = await prisma.$transaction(async (tx) => {
    await lockProjectDeploymentOperations(tx, project.id);
    const blocking = await tx.deployment.findFirst({ where: { projectId: project.id, status: { in: BLOCKING_STATUSES } } });
    if (blocking) {
      const error = new Error(`Wait for the current ${blocking.status.toLowerCase().replaceAll("_", " ")} operation to finish.`);
      error.statusCode = 409;
      throw error;
    }
    const active = await tx.deployment.findFirst({ where: { projectId: project.id, status: { in: SUPERSEDABLE_STATUSES } } });
    if (active) {
      superseded = true;
      await tx.deployment.updateMany({
        where: { projectId: project.id, status: { in: SUPERSEDABLE_STATUSES } },
        data: { status: "CANCELLED", stage: "CANCELLED", currentStep: "CANCELLED", error: "Superseded by a new deployment", workerJobId: null, completedAt: new Date() },
      });
    }
    const created = await tx.deployment.create({
      data: {
        projectId: project.id,
        status: "QUEUED",
        stage: "QUEUED",
        currentStep: "QUEUED",
        target,
        configVersion: project.configVersion,
        logs: [],
        trigger,
        commitSha: commit?.sha || null,
        commitMessage: commit?.message ? String(commit.message).slice(0, 500) : null,
        commitAuthor: commit?.author ? String(commit.author).slice(0, 120) : null,
      },
    });
    const jobId = `deploy-${created.id}-${crypto.randomUUID()}`;
    const updated = await tx.deployment.update({ where: { id: created.id }, data: { workerJobId: jobId } });
    await tx.project.update({ where: { id: project.id }, data: { status: "Deploying" } });
    return { deployment: updated, workerJobId: jobId };
  }, { timeout: 15_000 });

  if (superseded) await removeDeploymentJobs(project.id).catch(() => {});
  try {
    const queueResult = await addDeploymentJob({ deploymentId: deployment.id, projectId: project.id, userId: project.userId, target }, { jobId: workerJobId });
    return { deployment, queueMode: queueResult.mode };
  } catch (error) {
    await prisma.$transaction([
      prisma.deployment.update({ where: { id: deployment.id }, data: { status: "FAILED", stage: "FAILED", error: error.message, completedAt: new Date() } }),
      prisma.project.update({ where: { id: project.id }, data: { status: "Deployment Failed" } }),
    ]);
    throw error;
  }
}

export async function buildTeardownSnapshot(tx, projectId) {
  const deployments = await tx.deployment.findMany({
    where: { projectId, status: { not: "DESTROYED" } },
    select: { id: true, status: true, resources: true },
    orderBy: { createdAt: "asc" },
  });
  try {
    return {
      deploymentIds: deployments.map(({ id }) => id),
      resources: validateResourceManifests(uniqueResources(deployments)),
    };
  } catch (error) {
    error.statusCode = error.statusCode || 422;
    throw error;
  }
}

/** Queues a verified teardown of everything a project created (used for closed pull-request previews). */
export async function queueProjectTeardown(project) {
  const ACTIVE = ["QUEUED", "BUILDING", "PUSHING", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "ROLLING_BACK", "DESTROYING"];
  const deployment = await prisma.$transaction(async (tx) => {
    await lockProjectDeploymentOperations(tx, project.id);
    const active = await tx.deployment.findFirst({ where: { projectId: project.id, status: { in: ACTIVE } } });
    if (active) {
      const error = new Error("Wait for the active deployment or teardown to finish before destroying infrastructure.");
      error.statusCode = 409;
      throw error;
    }
    const snapshot = await buildTeardownSnapshot(tx, project.id);
    const created = await tx.deployment.create({
      data: { projectId: project.id, status: "DESTROYING", stage: "DESTROY", currentStep: "DESTROY", teardownResources: snapshot.resources, teardownDeploymentIds: snapshot.deploymentIds },
    });
    return tx.deployment.update({
      where: { id: created.id },
      data: { workerJobId: `destroy-${created.id}-${crypto.randomUUID()}`, teardownDeploymentIds: [...snapshot.deploymentIds, created.id] },
    });
  }, { timeout: 15_000 });
  try {
    await addDestroyJob({ projectId: project.id, deploymentId: deployment.id, userId: project.userId }, { jobId: deployment.workerJobId });
  } catch (error) {
    await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "DESTROY_FAILED", stage: "DESTROY_FAILED", workerJobId: null, error: error.message, completedAt: new Date() } }).catch(() => {});
    throw error;
  }
  return deployment;
}
