import crypto from "node:crypto";
import {
  ECRClient,
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  DescribeImagesCommand,
  GetAuthorizationTokenCommand,
  ListTagsForResourceCommand,
} from "@aws-sdk/client-ecr";
import { emitDeploymentLog } from "./logsService.js";
import { runCommand } from "./commandRunner.js";

export function getRepositoryName(project) {
  const baseName = String(project.name || "skyforge-app")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "skyforge-app";
  const stableId = crypto.createHash("sha256").update(String(project.id || "unknown")).digest("hex").slice(0, 10);
  return `skyforge-${baseName.slice(0, 180)}-${stableId}`.slice(0, 240);
}

function clientConfig(credentials) {
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) {
    throw new Error("Valid AWS credentials are required to push a container image.");
  }
  return {
    region: credentials.region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
  };
}

export async function pushImageToEcr(deploymentId, project, credentials, localTag, onResources, options = {}) {
  const config = clientConfig(credentials);
  const ecr = options.ecrClient || new ECRClient(config);
  const log = options.log || emitDeploymentLog;
  const repositoryName = getRepositoryName(project);
  const region = credentials.region || process.env.AWS_REGION || "ap-south-1";
  let resources = null;

  const checkpoint = async (partialResources = {}) => {
    resources = {
      type: "ECS_FARGATE",
      repositoryName,
      region,
      accountId: credentials.accountId || process.env.AWS_ACCOUNT_ID || null,
      ...(resources || {}),
      ...partialResources,
    };
    await onResources?.({ ...resources });
  };

  log(deploymentId, {
    stage: "PUSHING",
    message: `[ECR] Verifying repository ${repositoryName}...`,
    level: "info",
  });

  // Record the deterministic repository identity before any create call. If
  // AWS creates the repository but the response is lost, teardown still has a
  // safe identity to reconcile and remove.
  await checkpoint();

  try {
    let repositoryExists = false;
    let existingRepositoryArn = null;
    try {
      const described = await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] }));
      repositoryExists = Array.isArray(described.repositories) && described.repositories.length > 0;
      existingRepositoryArn = described.repositories?.[0]?.repositoryArn || null;
    } catch (error) {
      if (!["RepositoryNotFoundException", "RepositoryNotFound"].includes(error.name)) throw error;
    }

    if (repositoryExists && existingRepositoryArn) {
      const tagged = await ecr.send(new ListTagsForResourceCommand({ resourceArn: existingRepositoryArn }));
      const managed = tagged.tags?.some((tag) => tag.Key === "skyforge:managed" && tag.Value === "true");
      if (!managed) throw new Error("The existing ECR repository is not owned by SkyForge.");
    }
    if (!repositoryExists) {
      await ecr.send(new CreateRepositoryCommand({
        repositoryName,
        imageTagMutability: "IMMUTABLE",
        imageScanningConfiguration: { scanOnPush: true },
        tags: [
          { Key: "skyforge:managed", Value: "true" },
          { Key: "skyforge:project-id", Value: String(project.id || "unknown").slice(0, 256) },
        ],
      }));
    }
    // Persist the repository identity before any later push operation can fail.
    await checkpoint();

    const auth = await ecr.send(new GetAuthorizationTokenCommand({}));
    const authData = auth.authorizationData?.[0];
    if (!authData?.authorizationToken || !authData?.proxyEndpoint) {
      throw new Error("ECR did not return a registry authorization token.");
    }
    const decodedToken = Buffer.from(authData.authorizationToken, "base64").toString("utf-8");
    const separator = decodedToken.indexOf(":");
    const password = separator >= 0 ? decodedToken.slice(separator + 1) : "";
    if (!password) throw new Error("ECR returned an invalid registry authorization token.");

    const registry = authData.proxyEndpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const imageTag = `${String(localTag).replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120)}-${Date.now()}`;
    const remoteImage = `${registry}/${repositoryName}:${imageTag}`;
    await checkpoint({ registry, imageTag, imageUri: remoteImage });
    const onLine = (line) => log(deploymentId, {
      stage: "PUSHING",
      message: `[ECR] ${line.slice(0, 240)}`,
      level: /error|failed|fatal/i.test(line) ? "warn" : "info",
    });

    await runCommand("docker", ["login", "--username", "AWS", "--password-stdin", registry], {
      input: `${password}\n`,
      timeout: 30_000,
      onLine,
    });
    try {
      await runCommand("docker", ["tag", localTag, remoteImage], { timeout: 30_000, onLine });
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await runCommand("docker", ["push", remoteImage], {
            timeout: Number.parseInt(process.env.PUSH_TIMEOUT_MS || "900000", 10),
            onLine,
          });
          break;
        } catch (pushErr) {
          const isTransient = /timeout|EOF|connection reset|broken pipe|retry|temporary|500|502|503|504/i.test(String(pushErr.message || ""));
          if (attempt < 3 && isTransient) {
            log(deploymentId, {
              stage: "PUSHING",
              message: `[ECR] Layer upload attempt ${attempt} notice: transient network timeout. Resuming push in 3s...`,
              level: "warn",
            });
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          throw pushErr;
        }
      }
    } finally {
      await runCommand("docker", ["logout", registry], { timeout: 30_000 }).catch(() => {});
      await runCommand("docker", ["image", "rm", "--force", localTag], { timeout: 30_000 }).catch(() => {});
      await runCommand("docker", ["image", "rm", "--force", remoteImage], { timeout: 30_000 }).catch(() => {});
    }

    const described = await ecr.send(new DescribeImagesCommand({
      repositoryName,
      imageIds: [{ imageTag }],
    }));
    const digest = described.imageDetails?.[0]?.imageDigest || null;
    if (!digest) throw new Error("ECR did not return the pushed image digest.");
    const immutableUri = `${registry}/${repositoryName}@${digest}`;
    await checkpoint({ imageUri: immutableUri, imageDigest: digest });
    log(deploymentId, {
      stage: "PUSHING",
      message: `[ECR] Image pushed successfully to ${immutableUri}`,
      level: "success",
    });
    return { success: true, ecrUri: immutableUri, repositoryName, registry, imageDigest: digest, imageTag };
  } catch (error) {
    // A repository may already exist even when authentication, Docker, or image
    // verification fails. Preserve that identity so teardown can remove it.
    if (resources && error && typeof error === "object") {
      error.resources = { ...resources, ...(error.resources && typeof error.resources === "object" ? error.resources : {}) };
    }
    throw error;
  }
}

export function createEcrClient(credentials) {
  return new ECRClient(clientConfig(credentials));
}
