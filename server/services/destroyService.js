import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prisma from "../config/db.js";
import { emitDeploymentLog } from "./logsService.js";
import { getAwsCredentials } from "./awsConnectionService.js";
import { destroyEcsResources, discoverProjectResources } from "./ecsService.js";
import { destroyStaticResources } from "./staticDeployer.js";
import { createEcrClient, getRepositoryName } from "./ecrService.js";
import { DeleteRepositoryCommand, DescribeRepositoriesCommand, ListTagsForResourceCommand } from "@aws-sdk/client-ecr";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { uniqueResources, validateResourceManifests } from "./resourceUtils.js";

const GENERATED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../generated");

async function credentialsFor(userId) {
  const connection = await prisma.awsConnection.findUnique({ where: { userId } });
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
  return null;
}

function isMissingEcrRepository(error) {
  return error?.name === "RepositoryNotFoundException" || error?.name === "RepositoryNotFound";
}

async function verifyEcrRepositoryDeleted(ecr, repositoryName) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const result = await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] }));
      if (!result.repositories?.length) return;
    } catch (error) {
      if (isMissingEcrRepository(error)) return;
      throw error;
    }
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  throw new Error(`ECR repository ${repositoryName} still exists after deletion.`);
}

async function deleteEcrRepositories(credentials, deploymentId, recordedNames = []) {
  if (!credentials) return;
  const repositoryNames = new Set(recordedNames.filter((name) => typeof name === "string" && name.trim()));
  // Never derive and force-delete a repository that was not recorded in a
  // resource manifest; an identically named pre-existing repository may belong
  // to another operator.
  if (!repositoryNames.size) return;
  const ecr = createEcrClient(credentials);
  for (const repositoryName of repositoryNames) {
    let described;
    try {
      described = await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] }));
    } catch (error) {
      if (isMissingEcrRepository(error)) continue;
      throw error;
    }
    const repositoryArn = described.repositories?.[0]?.repositoryArn;
    if (repositoryArn) {
      const tagged = await ecr.send(new ListTagsForResourceCommand({ resourceArn: repositoryArn }));
      const managed = tagged.tags?.some((tag) => tag.Key === "skyforge:managed" && tag.Value === "true");
      if (!managed) throw new Error(`ECR repository ${repositoryName} is not owned by SkyForge.`);
    }
    try {
      await ecr.send(new DeleteRepositoryCommand({ repositoryName, force: true }));
    } catch (error) {
      if (!isMissingEcrRepository(error)) throw error;
    }
    await verifyEcrRepositoryDeleted(ecr, repositoryName);
    emitDeploymentLog(deploymentId, { stage: "DESTROY", message: `[ECR] Deleted and verified repository ${repositoryName}.`, level: "success" });
  }
}

/**
 * Finds every resource named for this project (recorded or not), deletes what remains, then checks
 * again. Throws, listing the survivors, unless AWS reports nothing left that belongs to the project.
 */
async function sweepAndVerify({ credentials, project, deploymentId }) {
  const repositoryName = getRepositoryName(project);
  const before = await discoverProjectResources({ credentials, project, repositoryName });
  if (before.found.length) {
    emitDeploymentLog(deploymentId, { stage: "DESTROY", message: `[SWEEP] Removing ${before.found.length} remaining resource(s): ${before.found.join("; ")}`, level: "warn" });
    await destroyEcsResources({ credentials, resources: before.manifest, deploymentId });
    if (before.manifest.repositoryName) await deleteEcrRepositories(credentials, deploymentId, [before.manifest.repositoryName]);
  }
  const after = await discoverProjectResources({ credentials, project, repositoryName });
  if (after.found.length) throw new Error(`These AWS resources still exist after teardown: ${after.found.join("; ")}`);
  emitDeploymentLog(deploymentId, { stage: "DESTROY", message: "[SWEEP] Verified with AWS: no resources for this project remain, so it no longer incurs charges.", level: "success" });
}

function supersededError(message = "This teardown operation was superseded by a newer project operation.") {
  const error = new Error(message);
  error.code = "DESTROY_SUPERSEDED";
  return error;
}

function snapshotResources(value, fallback) {
  if (Array.isArray(value)) return validateResourceManifests(value);
  if (value === null || value === undefined) return validateResourceManifests(fallback || []);
  throw new Error("Teardown resource snapshot is malformed.");
}

async function assertManifestAccount(credentials, manifests) {
  const expected = [...new Set(manifests.map((manifest) => manifest.accountId).filter((value) => typeof value === "string" && value))];
  if (!expected.length) return;
  const region = manifests.find((manifest) => manifest.region)?.region || credentials.region;
  const identity = await new STSClient({
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
  }).send(new GetCallerIdentityCommand({}));
  if (expected.some((accountId) => accountId !== identity.Account)) {
    throw new Error("AWS credentials do not match the account recorded for the deployment resources.");
  }
}

async function markProjectDestroyedIfCurrent(projectId, operationId) {
  const newest = await prisma.deployment.findFirst({ where: { projectId }, orderBy: { createdAt: "desc" }, select: { id: true, status: true } });
  if (newest && newest.id !== operationId && newest.status !== "DESTROYED") return;
  await prisma.project.update({ where: { id: projectId }, data: { status: "Destroyed" } }).catch(() => {});
}

export async function destroyProjectInfrastructure({ projectId, deploymentId, userId, jobId }) {
  const project = await prisma.project.findFirst({ where: { id: projectId, userId } });
  if (!project) throw new Error("Project not found");

  let activeId = deploymentId || null;
  try {
    const operation = await prisma.deployment.findFirst({
      where: { id: deploymentId, projectId, project: { userId } },
      select: {
        id: true,
        status: true,
        workerJobId: true,
        createdAt: true,
        teardownResources: true,
        teardownDeploymentIds: true,
      },
    });
    if (!operation) throw new Error("Deployment record is not part of this project.");
    activeId = operation.id;

    if (jobId && operation.workerJobId !== jobId) throw supersededError("This teardown job no longer owns the deployment operation.");

    // A retry must never collect resources from a deployment created after the
    // teardown snapshot. Such a retry is stale and must not touch the newer
    // project's AWS identities.
    const newer = await prisma.deployment.findFirst({
      where: { projectId, id: { not: operation.id }, createdAt: { gt: operation.createdAt } },
      select: { id: true },
    });
    if (newer) throw supersededError();

    let fallback = [];
    let deploymentIds = Array.isArray(operation.teardownDeploymentIds)
      ? operation.teardownDeploymentIds.filter((id) => typeof id === "string" && id)
      : [];
    if (!deploymentIds.length) {
      const deployments = await prisma.deployment.findMany({
        where: { projectId, status: { not: "DESTROYED" } },
        select: { id: true, status: true, resources: true },
      });
      deploymentIds = deployments.map(({ id }) => id);
      fallback = uniqueResources(deployments);
    }
    if (!deploymentIds.includes(operation.id)) deploymentIds.push(operation.id);
    const resources = snapshotResources(operation.teardownResources, fallback);

    const claim = await prisma.deployment.updateMany({
      where: { id: operation.id, ...(jobId ? { workerJobId: jobId } : {}) },
      data: { status: "DESTROYING", stage: "DESTROY", currentStep: "DESTROY" },
    });
    if (claim.count !== 1) throw supersededError();
    emitDeploymentLog(operation.id, { stage: "DESTROY", message: `[DESTROY] Starting verified teardown for ${project.name}.`, level: "warn" });

    // Credentials are needed even with no recorded resources: the sweep below looks for
    // anything a crashed or interrupted operation created without recording it.
    const credentials = await credentialsFor(userId);
    if (resources.length && !credentials) throw new Error("AWS credentials are required to destroy existing cloud resources.");
    if (resources.length) await assertManifestAccount(credentials, resources);

    const ecrDeletes = [];
    for (const manifest of resources) {
      const resourceCredentials = manifest.region ? { ...credentials, region: manifest.region } : credentials;
      if (manifest.type === "ECS_FARGATE") {
        await destroyEcsResources({ credentials: resourceCredentials, resources: manifest, deploymentId: operation.id });
        ecrDeletes.push({ credentials: resourceCredentials, repositoryNames: [manifest.repositoryName].filter(Boolean) });
      }
      if (manifest.type === "S3_CLOUDFRONT" || manifest.type === "S3_STATIC_WEBSITE") {
        await destroyStaticResources({ credentials: resourceCredentials, resources: manifest, deploymentId: operation.id });
      }
    }
    for (const entry of ecrDeletes) {
      await deleteEcrRepositories(entry.credentials, operation.id, entry.repositoryNames);
    }
    if (credentials) await sweepAndVerify({ credentials, project, deploymentId: operation.id });
    else emitDeploymentLog(operation.id, { stage: "DESTROY", message: "[SWEEP] No AWS connection; the leftover-resource sweep was skipped.", level: "warn" });

    const projectDir = path.resolve(GENERATED_DIR, projectId);
    if (projectDir.startsWith(`${GENERATED_DIR}${path.sep}`) && fs.existsSync(projectDir)) {
      try {
        fs.rmSync(projectDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn(`[DESTROY] Could not remove local workspace ${projectDir}: ${cleanupError.message}`);
      }
    }

    const stillOwned = await prisma.deployment.findFirst({ where: { id: operation.id, workerJobId: jobId || undefined, status: "DESTROYING" }, select: { id: true } });
    if (!stillOwned) throw supersededError();
    await prisma.deployment.updateMany({
      where: { projectId, id: { in: deploymentIds } },
      data: {
        status: "DESTROYED",
        stage: "DESTROYED",
        currentStep: "DESTROYED",
        liveUrl: null,
        healthStatus: "TORN_DOWN",
        artifactPath: null,
        workerJobId: null,
        error: null,
        completedAt: new Date(),
      },
    });
    await markProjectDestroyedIfCurrent(projectId, operation.id);
    // Security state referred to the deleted resources; keep only the scanner token.
    await prisma.project.update({
      where: { id: projectId },
      data: { siteOffline: false, protection: project.protection?.scanToken ? { scanToken: project.protection.scanToken } : null },
    }).catch(() => {});
    emitDeploymentLog(operation.id, { stage: "DESTROY_COMPLETE", message: "[DESTROY] All snapshotted project resources were removed and verified.", level: "success" });
    return { success: true, status: "DESTROYED", deploymentId: operation.id };
  } catch (error) {
    if (activeId) {
      const statusData = {
        status: "DESTROY_FAILED",
        stage: "DESTROY_FAILED",
        currentStep: "DESTROY",
        error: String(error.message).slice(0, 2000),
        completedAt: new Date(),
      };
      if (error.code !== "DESTROY_SUPERSEDED") await prisma.project.update({ where: { id: projectId }, data: { status: "Teardown Failed" } }).catch(() => {});
      await prisma.deployment.updateMany({
        where: { id: activeId, ...(jobId ? { workerJobId: jobId } : {}) },
        data: { ...statusData, ...(error.code === "DESTROY_SUPERSEDED" ? { workerJobId: null } : {}) },
      }).catch(() => {});
      emitDeploymentLog(activeId, { stage: "DESTROY_FAILED", message: `[ERROR] Teardown failed: ${error.message}`, level: "error" });
    }
    throw error;
  }
}
