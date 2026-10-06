import crypto from "node:crypto";
import {
  ECRClient,
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  DescribeImagesCommand,
  DescribeImageScanFindingsCommand,
  PutImageScanningConfigurationCommand,
  StartImageScanCommand,
  BatchGetImageCommand,
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

    if (options.remoteBuild) {
      // Cloud build: the image is built and pushed inside AWS, nothing is uploaded from here.
      await options.remoteBuild({ remoteImage, registry, imageTag });
    } else {
    await runCommand("docker", ["login", "--username", "AWS", "--password-stdin", registry], {
      input: `${password}\n`,
      timeout: 30_000,
      onLine,
    });
    try {
      await runCommand("docker", ["tag", localTag, remoteImage], { timeout: 30_000, onLine });
      // docker push prints nothing while a big layer uploads, so a stall can only be judged by
      // layers finishing. Each retry waits longer (a slow link is not a dead one), and the last
      // attempt relies on the overall timeout alone.
      const baseStall = Number.parseInt(process.env.PUSH_STALL_MS || "240000", 10);
      // Every attempt keeps the layers that made it, so a flaky link gets there in the end.
      const stallFor = [baseStall, baseStall * 2.5, 0, 0, 0];
      const attempts = stallFor.length;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          await runCommand("docker", ["push", remoteImage], {
            timeout: Number.parseInt(process.env.PUSH_TIMEOUT_MS || "1800000", 10),
            // A layer finishing, or a new layer starting, is progress; endless "Waiting" is not.
            stallTimeout: stallFor[attempt - 1],
            isProgress: (line) => /Pushed|Layer already exists|Mounted from|Preparing|digest:/i.test(line),
            onLine,
          });
          break;
        } catch (pushErr) {
          const isTransient = /timeout|stalled|EOF|connection reset|broken pipe|retry|temporary|500|502|503|504|closed network|network connection|failed to copy|failed to do request/i.test(String(pushErr.message || ""));
          if (attempt < attempts && isTransient) {
            log(deploymentId, {
              stage: "PUSHING",
              message: `[ECR] Upload attempt ${attempt}/${attempts} ${/stalled/.test(pushErr.message) ? "stalled (no layer finished for a while)" : "hit a network error"}. Retrying in 10s; layers already uploaded are skipped.`,
              level: "warn",
            });
            await new Promise((r) => setTimeout(r, 10_000));
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

/**
 * BuildKit pushes an image index (platform image + provenance attestation), which ECR cannot scan.
 * Resolves the index to the linux/amd64 image manifest that ECS actually runs.
 */
async function scannableDigest(ecr, repositoryName, imageDigest) {
  try {
    const result = await ecr.send(new BatchGetImageCommand({
      repositoryName,
      imageIds: [{ imageDigest }],
      acceptedMediaTypes: ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json", "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"],
    }));
    const manifest = JSON.parse(result.images?.[0]?.imageManifest || "{}");
    const platform = (manifest.manifests || []).find((entry) => entry.platform?.os === "linux" && entry.platform?.architecture === "amd64");
    return platform?.digest || imageDigest;
  } catch {
    return imageDigest;
  }
}

/**
 * Container image vulnerability scan results (ECR basic scanning, free). Waits up to `waitMs`
 * for an in-progress scan. Returns { status, counts, top: [{ name, severity, package }] }.
 */
export async function getImageScanFindings({ credentials, repositoryName, imageDigest: pushedDigest, waitMs = 120_000 }) {
  const ecr = createEcrClient(credentials);
  const imageDigest = await scannableDigest(ecr, repositoryName, pushedDigest);
  // Repositories created before scan-on-push was enabled need it switched on for later pushes.
  await ecr.send(new PutImageScanningConfigurationCommand({ repositoryName, imageScanningConfiguration: { scanOnPush: true } })).catch(() => {});
  const deadline = Date.now() + waitMs;
  let started = false;
  for (;;) {
    let result;
    try {
      result = await ecr.send(new DescribeImageScanFindingsCommand({ repositoryName, imageId: { imageDigest }, maxResults: 50 }));
    } catch (error) {
      if (error.name !== "ScanNotFoundException") throw error;
      // Account-level scanning rules override the repository's scan-on-push flag, so the image
      // may never have been scanned: start a basic scan explicitly (allowed once per day per image).
      if (started) return { status: "NOT_SCANNED", imageDigest };
      started = true;
      try {
        await ecr.send(new StartImageScanCommand({ repositoryName, imageId: { imageDigest } }));
      } catch (startError) {
        return { status: "NOT_SCANNED", imageDigest, detail: startError.message };
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      continue;
    }
    const status = result.imageScanStatus?.status;
    if (status === "COMPLETE" || status === "ACTIVE") {
      const findings = result.imageScanFindings?.findings || [];
      return {
        status: "COMPLETE",
        imageDigest,
        counts: result.imageScanFindings?.findingSeverityCounts || {},
        top: findings
          .filter((item) => ["CRITICAL", "HIGH"].includes(item.severity))
          .slice(0, 10)
          .map((item) => ({ name: item.name, severity: item.severity, package: item.attributes?.find((attribute) => attribute.key === "package_name")?.value || "" })),
      };
    }
    if (status === "FAILED" || status === "UNSUPPORTED_IMAGE") return { status, imageDigest, detail: result.imageScanStatus?.description };
    if (Date.now() > deadline) return { status: "IN_PROGRESS", imageDigest };
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}
