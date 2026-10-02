import {
  CloudFrontClient,
  CreateInvalidationCommand,
  DeleteDistributionCommand,
  DeleteOriginAccessControlCommand,
  GetDistributionCommand,
  GetOriginAccessControlCommand,
  UpdateDistributionCommand,
  waitUntilDistributionDeployed,
  waitUntilInvalidationCompleted,
} from "@aws-sdk/client-cloudfront";
import {
  S3Client,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  GetBucketTaggingCommand,
} from "@aws-sdk/client-s3";
import { emitDeploymentLog } from "./logsService.js";

function clientConfig(credentials) {
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) {
    throw new Error("Valid AWS credentials are required for static resource operations.");
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


function isMissingResourceError(error) {
  return error?.$metadata?.httpStatusCode === 404
    || /NoSuch|NotFound|not found/i.test(`${error?.name || ""} ${error?.message || ""}`);
}

async function verifyResourceAbsent(check, label) {
  const attempts = Math.min(20, Math.max(1, Number.parseInt(process.env.DESTROY_VERIFY_ATTEMPTS || "8", 10)));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (!(await check())) return;
    } catch (error) {
      if (isMissingResourceError(error)) return;
      throw error;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, Math.min(attempt * 1000, 5000)));
  }
  throw new Error(`${label} still exists after deletion.`);
}

async function removeStaleRootObjects(s3, bucket, keepKeys) {
  const staleKeys = [];
  let continuationToken;
  do {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
    for (const object of listed.Contents || []) {
      if (!object.Key.startsWith("releases/") && !keepKeys.has(object.Key)) staleKeys.push(object.Key);
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  for (let index = 0; index < staleKeys.length; index += 1000) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: staleKeys.slice(index, index + 1000).map((Key) => ({ Key })), Quiet: true },
    }));
  }
}

async function listReleaseFiles(s3, bucket, prefix, expectedFiles = []) {
  const found = new Set();
  let continuationToken;
  do {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }));
    for (const object of listed.Contents || []) {
      const relative = object.Key.slice(prefix.length);
      if (relative) found.add(relative);
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
  if (!found.has("index.html")) throw new Error("The previous static release is missing index.html.");
  if (Array.isArray(expectedFiles) && expectedFiles.length) {
    const missing = expectedFiles.filter((file) => typeof file === "string" && !found.has(file));
    if (missing.length) throw new Error("The previous static release is incomplete.");
  }
  return [...found];
}

export async function rollbackStaticDistribution({ credentials, resources, previousResources }) {
  if (resources?.type === "S3_STATIC_WEBSITE" || previousResources?.type === "S3_STATIC_WEBSITE") {
    return { success: true, type: "S3_STATIC_WEBSITE" };
  }
  if (!resources?.distributionId || !previousResources?.defaultRoot || !previousResources?.releasePrefix) {
    throw new Error("No previous static distribution revision is available for rollback.");
  }
  if (resources.distributionId !== previousResources.distributionId || resources.bucket !== previousResources.bucket) {
    throw new Error("Static rollback revisions do not share the same CloudFront distribution and bucket.");
  }
  const config = credentials ? clientConfig(credentials) : { region: resources.region };
  const cloudfront = new CloudFrontClient(config);
  const s3 = new S3Client(config);
  if (credentials) await listReleaseFiles(s3, resources.bucket, previousResources.releasePrefix, previousResources.releaseFiles);

  const current = await cloudfront.send(new GetDistributionCommand({ Id: resources.distributionId }));
  const distConfig = current.Distribution?.Config;
  if (!distConfig) throw new Error("CloudFront returned no distribution configuration.");
  const originalConfig = JSON.parse(JSON.stringify(distConfig));
  const previousOriginPath = previousResources.originPath || previousResources.releasePrefix;
  const origin = distConfig.Origins?.Items?.[0];
  if (!origin) throw new Error("CloudFront returned no origin configuration.");
  const updatedConfig = {
    ...distConfig,
    Origins: {
      ...distConfig.Origins,
      Items: [{ ...origin, OriginPath: previousOriginPath }],
    },
    DefaultRootObject: previousResources.defaultRoot,
    CustomErrorResponses: [
      { ErrorCode: 403, ResponseCode: 200, ResponsePagePath: `/${previousResources.defaultRoot}`, ErrorCachingMinTTL: 0 },
      { ErrorCode: 404, ResponseCode: 200, ResponsePagePath: `/${previousResources.defaultRoot}`, ErrorCachingMinTTL: 0 },
    ],
  };

  let mutated = false;
  try {
    await cloudfront.send(new UpdateDistributionCommand({ Id: resources.distributionId, IfMatch: current.ETag, DistributionConfig: updatedConfig }));
    mutated = true;
    await waitUntilDistributionDeployed(
      { client: cloudfront, maxWaitTime: Number.parseInt(process.env.CLOUDFRONT_WAIT_SECONDS || "900", 10) },
      { Id: resources.distributionId },
    );
    const invalidation = await cloudfront.send(new CreateInvalidationCommand({
      DistributionId: resources.distributionId,
      InvalidationBatch: {
        CallerReference: `skyforge-rollback-${Date.now()}`,
        Paths: { Quantity: 1, Items: ["/*"] },
      },
    }));
    if (!invalidation.Invalidation?.Id) throw new Error("CloudFront did not return a rollback invalidation ID.");
    await waitUntilInvalidationCompleted(
      { client: cloudfront, maxWaitTime: Number.parseInt(process.env.CLOUDFRONT_WAIT_SECONDS || "900", 10) },
      { Id: resources.distributionId, InvalidationId: invalidation.Invalidation.Id },
    );
    return { success: true, defaultRoot: previousResources.defaultRoot, originPath: previousOriginPath };
  } catch (error) {
    if (mutated) {
      try {
        const latest = await cloudfront.send(new GetDistributionCommand({ Id: resources.distributionId }));
        await cloudfront.send(new UpdateDistributionCommand({ Id: resources.distributionId, IfMatch: latest.ETag, DistributionConfig: originalConfig }));
        await waitUntilDistributionDeployed(
          { client: cloudfront, maxWaitTime: Number.parseInt(process.env.CLOUDFRONT_WAIT_SECONDS || "900", 10) },
          { Id: resources.distributionId },
        );
      } catch (restoreError) {
        console.error(`[CLOUDFRONT] Could not restore the previous distribution revision: ${restoreError.message}`);
      }
    }
    throw error;
  }
}

export async function destroyStaticResources({ credentials, resources, deploymentId }) {
  if (!resources?.bucket || !credentials?.accessKeyId) return;
  const config = clientConfig(credentials);
  const s3 = new S3Client(config);
  const cloudfront = new CloudFrontClient(config);
  let tagged;
  try {
    tagged = await s3.send(new GetBucketTaggingCommand({ Bucket: resources.bucket }));
  } catch (error) {
    if (isMissingResourceError(error)) return;
    throw error;
  }
  const managed = tagged.TagSet?.some((tag) => tag.Key === "skyforge:managed" && tag.Value === "true");
  if (!managed) throw new Error(`S3 bucket ${resources.bucket} is not owned by SkyForge.`);

  if (resources.distributionId) {
    try {
      let current = await cloudfront.send(new GetDistributionCommand({ Id: resources.distributionId }));
      if (current.Distribution?.Config?.Enabled) {
        await cloudfront.send(new UpdateDistributionCommand({
          Id: resources.distributionId,
          IfMatch: current.ETag,
          DistributionConfig: { ...current.Distribution.Config, Enabled: false },
        }));
        await waitUntilDistributionDeployed(
          { client: cloudfront, maxWaitTime: Number.parseInt(process.env.CLOUDFRONT_WAIT_SECONDS || "900", 10) },
          { Id: resources.distributionId },
        );
        current = await cloudfront.send(new GetDistributionCommand({ Id: resources.distributionId }));
      }
      await cloudfront.send(new DeleteDistributionCommand({ Id: resources.distributionId, IfMatch: current.ETag }));
      await verifyResourceAbsent(async () => {
        const pending = await cloudfront.send(new GetDistributionCommand({ Id: resources.distributionId }));
        return Boolean(pending.Distribution);
      }, `CloudFront distribution ${resources.distributionId}`);
    } catch (error) {
      if (!isMissingResourceError(error)) throw error;
    }
  }
  if (resources.oacId) {
    try {
      const currentOac = await cloudfront.send(new GetOriginAccessControlCommand({ Id: resources.oacId }));
      await cloudfront.send(new DeleteOriginAccessControlCommand({ Id: resources.oacId, IfMatch: currentOac.ETag }));
      await verifyResourceAbsent(async () => {
        const pending = await cloudfront.send(new GetOriginAccessControlCommand({ Id: resources.oacId }));
        return Boolean(pending.OriginAccessControl);
      }, `CloudFront origin access control ${resources.oacId}`);
    } catch (error) {
      if (!isMissingResourceError(error)) throw error;
    }
  }

  let continuationToken;
  try {
    do {
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: resources.bucket, ContinuationToken: continuationToken }));
      if (listed.Contents?.length) {
        await s3.send(new DeleteObjectsCommand({
          Bucket: resources.bucket,
          Delete: { Objects: listed.Contents.map((object) => ({ Key: object.Key })), Quiet: true },
        }));
      }
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (error) {
    if (!isMissingResourceError(error)) throw error;
  }
  try {
    await s3.send(new DeleteBucketCommand({ Bucket: resources.bucket }));
  } catch (error) {
    if (!isMissingResourceError(error)) throw error;
  }
  await verifyResourceAbsent(async () => {
    await s3.send(new HeadBucketCommand({ Bucket: resources.bucket }));
    return true;
  }, `S3 bucket ${resources.bucket}`);
  emitDeploymentLog(deploymentId, { stage: "DESTROY", message: `[S3/CLOUDFRONT] Deleted and verified ${resources.bucket} and its distribution.`, level: "success" });
}
