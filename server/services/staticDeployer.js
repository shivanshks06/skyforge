import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import {
  CloudFrontClient,
  CreateDistributionCommand,
  CreateOriginAccessControlCommand,
  CreateInvalidationCommand,
  DeleteDistributionCommand,
  DeleteOriginAccessControlCommand,
  GetDistributionCommand,
  GetOriginAccessControlCommand,
  ListDistributionsCommand,
  UpdateDistributionCommand,
  waitUntilDistributionDeployed,
  waitUntilInvalidationCompleted,
} from "@aws-sdk/client-cloudfront";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetBucketLocationCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  PutBucketWebsiteCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  GetBucketTaggingCommand,
  PutBucketTaggingCommand,
} from "@aws-sdk/client-s3";
import { emitDeploymentLog } from "./logsService.js";
import { isBlockedSecretFile } from "./secretFilePolicy.js";
import { awsDomainSuffixForRegion, awsPartitionForRegion } from "./awsPartition.js";

function clientConfig(credentials) {
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) {
    throw new Error("Valid AWS credentials are required for static deployment.");
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

function bucketNameFor(project, accountId) {
  const slug = String(project.name || "skyforge-app")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "skyforge-app";
  const stableId = crypto.createHash("sha256").update(`${project.id || "unknown"}:${accountId}`).digest("hex").slice(0, 12);
  return `skyforge-${slug.slice(0, 38)}-${stableId}`.slice(0, 63).replace(/-+$/, "");
}

function originDomain(bucket, region) {
  return `${bucket}.s3.${region}.${awsDomainSuffixForRegion(region)}`;
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".map": "application/json",
    ".wasm": "application/wasm",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
  }[extension] || "application/octet-stream";
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

async function ensureBucket(s3, bucket, region, deploymentId, projectId) {
  let bucketExists = true;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (![404, "NotFound", "NoSuchBucket"].includes(error.$metadata?.httpStatusCode) && error.name !== "NotFound" && error.name !== "NoSuchBucket") {
      throw error;
    }
    bucketExists = false;
    emitDeploymentLog(deploymentId, { stage: "DEPLOYING", message: `[S3] Creating private bucket ${bucket}...`, level: "info" });
    const params = { Bucket: bucket };
    if (region !== "us-east-1") params.CreateBucketConfiguration = { LocationConstraint: region };
    await s3.send(new CreateBucketCommand(params));
  }

  if (bucketExists) {
    let tagged;
    try {
      tagged = await s3.send(new GetBucketTaggingCommand({ Bucket: bucket }));
    } catch (err) {
      if (err.name !== "NoSuchTagSet" && err.Code !== "NoSuchTagSet" && err.$metadata?.httpStatusCode !== 404) {
        throw err;
      }
    }
    const managed = tagged?.TagSet?.some((tag) => tag.Key === "skyforge:managed" && tag.Value === "true");
    if (!managed) {
      await s3.send(new PutBucketTaggingCommand({
        Bucket: bucket,
        Tagging: { TagSet: [
          { Key: "skyforge:managed", Value: "true" },
          { Key: "skyforge:project-id", Value: String(projectId || "unknown").slice(0, 256) },
        ] },
      })).catch(() => {});
    }
  } else {
    await s3.send(new PutBucketTaggingCommand({
      Bucket: bucket,
      Tagging: { TagSet: [
        { Key: "skyforge:managed", Value: "true" },
        { Key: "skyforge:project-id", Value: String(projectId || "unknown").slice(0, 256) },
      ] },
    }));
  }

  await s3.send(new PutPublicAccessBlockCommand({
    Bucket: bucket,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    },
  }));
  await s3.send(new PutBucketEncryptionCommand({
    Bucket: bucket,
    ServerSideEncryptionConfiguration: {
      Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
    },
  }));
  await s3.send(new PutBucketLifecycleConfigurationCommand({
    Bucket: bucket,
    LifecycleConfiguration: {
      Rules: [{
        ID: "skyforge-release-retention",
        Status: "Enabled",
        Filter: { Prefix: "releases/" },
        Expiration: { Days: 30 },
      }],
    },
  }));
  return bucket;
}

async function uploadAssets(s3, bucket, deploymentId, outputDir) {
  const files = [];
  const releaseFiles = [];
  let totalBytes = 0;
  const maxFiles = 10_000;
  const maxBytes = 500 * 1024 * 1024;
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in static output: ${entry.name}`);
      if (isBlockedSecretFile(entry.name)) {
        throw new Error(`Secret-like files cannot be published: ${entry.name}`);
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        totalBytes += stat.size;
        if (files.length >= maxFiles || totalBytes > maxBytes) throw new Error("Static build output exceeds deployment limits.");
        files.push(fullPath);
      } else {
        throw new Error(`Unsupported file type in static output: ${entry.name}`);
      }
    }
  }
  await walk(outputDir);
  if (!files.some((file) => path.basename(file).toLowerCase() === "index.html")) throw new Error("Static build output does not contain index.html.");

  for (const file of files) {
    const relative = path.relative(outputDir, file).split(path.sep).join("/");
    releaseFiles.push(relative);
    const body = await fs.readFile(file);
    const contentType = mimeType(file);
    const releaseCacheControl = relative === "index.html" ? "no-cache, no-store, must-revalidate" : "public,max-age=31536000,immutable";
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `releases/${deploymentId}/${relative}`,
      Body: body,
      ContentType: contentType,
      CacheControl: releaseCacheControl,
    }));
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: relative,
      Body: body,
      ContentType: contentType,
      CacheControl: releaseCacheControl,
    }));
  }
  emitDeploymentLog(deploymentId, {
    stage: "DEPLOYING",
    message: `[S3] Uploaded ${files.length} verified asset(s) under releases/${deploymentId}/.`,
    level: "success",
  });
  return { keyPrefix: `releases/${deploymentId}/`, fileCount: files.length, releaseFiles };
}

function distributionConfig(bucket, region, oacId, defaultRoot, callerReference, originPath = "") {
  const originId = `${bucket}-s3-origin`;
  return {
    CallerReference: callerReference,
    Comment: `SkyForge deployment for ${bucket}`,
    Enabled: true,
    Origins: {
      Quantity: 1,
      Items: [{
        Id: originId,
        DomainName: originDomain(bucket, region),
        ...(originPath ? { OriginPath: originPath } : {}),
        OriginAccessControlId: oacId,
        S3OriginConfig: { OriginAccessIdentity: "" },
      }],
    },
    DefaultRootObject: defaultRoot,
    DefaultCacheBehavior: {
      TargetOriginId: originId,
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: {
        Quantity: 3,
        Items: ["GET", "HEAD", "OPTIONS"],
        CachedMethods: {
          Quantity: 2,
          Items: ["GET", "HEAD"],
        },
      },
      Compress: true,
      ForwardedValues: {
        QueryString: false,
        Cookies: { Forward: "none" },
        Headers: {
          Quantity: 0,
        },
      },
      MinTTL: 0,
      DefaultTTL: 86400,
      MaxTTL: 31536000,
      TrustedSigners: { Enabled: false, Quantity: 0 },
    },
    CustomErrorResponses: {
      Quantity: 2,
      Items: [
        { ErrorCode: 403, ResponseCode: "200", ResponsePagePath: `/${defaultRoot}`, ErrorCachingMinTTL: 0 },
        { ErrorCode: 404, ResponseCode: "200", ResponsePagePath: `/${defaultRoot}`, ErrorCachingMinTTL: 0 },
      ],
    },
  };
}

async function findDistribution(cloudfront, bucket, region) {
  let marker;
  do {
    const page = await cloudfront.send(new ListDistributionsCommand({ Marker: marker, MaxItems: 100 }));
    const match = page.DistributionList?.Items?.find((distribution) =>
      distribution.Origins?.Items?.some((origin) => origin.DomainName === originDomain(bucket, region)),
    );
    if (match) return match;
    marker = page.DistributionList?.IsTruncated ? page.DistributionList.NextMarker : undefined;
  } while (marker);
  return null;
}

async function ensureDistribution(cloudfront, bucket, region, deploymentId, releasePrefix, onResources) {
  let distribution = await findDistribution(cloudfront, bucket, region);
  let currentDistribution = null;
  let oacId = distribution?.OriginAccessControlId;
  if (distribution) {
    currentDistribution = await cloudfront.send(new GetDistributionCommand({ Id: distribution.Id }));
    oacId = currentDistribution.Distribution?.Config?.Origins?.Items?.[0]?.OriginAccessControlId || oacId;
    await onResources?.({
      distributionId: distribution.Id,
      distributionArn: currentDistribution.Distribution?.ARN,
      oacId,
      bucket,
      region,
    });
  }

  if (!oacId) {
    const oac = await cloudfront.send(new CreateOriginAccessControlCommand({
      OriginAccessControlConfig: {
        Name: `skyforge-${deploymentId}-${Date.now()}`,
        Description: `SkyForge OAC for ${bucket}`,
        OriginAccessControlOriginType: "s3",
        SigningBehavior: "always",
        SigningProtocol: "sigv4",
      },
    }));
    oacId = oac.OriginAccessControl?.Id;
  }
  if (!oacId) throw new Error("CloudFront did not return an origin access control ID.");
  await onResources?.({ oacId, bucket, region });

  const defaultRoot = "index.html";
  const config = distributionConfig(
    bucket,
    region,
    oacId,
    defaultRoot,
    currentDistribution?.Distribution?.Config?.CallerReference || `skyforge-${deploymentId}`,
    releasePrefix,
  );
  let result;
  if (distribution) {
    result = await cloudfront.send(new UpdateDistributionCommand({
      Id: distribution.Id,
      IfMatch: currentDistribution.ETag,
      DistributionConfig: config,
    }));
  } else {
    result = await cloudfront.send(new CreateDistributionCommand({ DistributionConfig: config }));
  }

  const distributionId = result.Distribution?.Id;
  if (!distributionId) throw new Error("CloudFront did not return a distribution ID.");
  await onResources?.({
    distributionId,
    distributionArn: result.Distribution?.ARN,
    oacId,
    bucket,
    region,
  });
  await waitUntilDistributionDeployed(
    { client: cloudfront, maxWaitTime: Number.parseInt(process.env.CLOUDFRONT_WAIT_SECONDS || "900", 10) },
    { Id: distributionId },
  );
  const deployed = await cloudfront.send(new GetDistributionCommand({ Id: distributionId }));
  const domainName = deployed.Distribution?.DomainName;
  if (!domainName) throw new Error("CloudFront did not return a public domain name.");

  return {
    distributionId,
    distributionArn: deployed.Distribution?.ARN,
    domainName: `https://${domainName}`,
    oacId,
    bucket,
    defaultRoot,
    releasePrefix,
    originPath: releasePrefix,
    originDomain: originDomain(bucket, region),
  };
}

async function applyCloudFrontOriginPolicy(s3, bucket, distributionArn, region) {
  if (!distributionArn) throw new Error("CloudFront did not return a distribution ARN for the OAC policy.");
  await s3.send(new PutBucketPolicyCommand({
    Bucket: bucket,
    Policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Sid: "AllowCloudFrontServicePrincipal",
        Effect: "Allow",
        Principal: { Service: "cloudfront.amazonaws.com" },
        Action: "s3:GetObject",
        Resource: `arn:${awsPartitionForRegion(region)}:s3:::${bucket}/*`,
        Condition: { StringEquals: { "AWS:SourceArn": distributionArn } },
      }],
    }),
  }));
}

export async function deployStaticProject({ deploymentId, project, credentials, outputDir, onResources }) {
  const config = clientConfig(credentials);
  const accountId = credentials.accountId || process.env.AWS_ACCOUNT_ID;
  if (!/^\d{12}$/.test(accountId || "")) throw new Error("AWS account ID is required for a globally unique static bucket.");
  const region = credentials.region || process.env.AWS_REGION || "ap-south-1";
  const bucket = bucketNameFor(project, accountId);
  const s3 = new S3Client(config);
  const cloudfront = new CloudFrontClient(config);

  emitDeploymentLog(deploymentId, { stage: "DEPLOYING", message: `[S3] Preparing origin bucket ${bucket}...`, level: "info" });
  const partialResources = { type: "S3_CLOUDFRONT", bucket, region, accountId: accountId || null };
  // Checkpoint the deterministic bucket identity before creation so a lost
  // create response cannot leave an unrecorded bucket behind.
  await onResources?.({ ...partialResources });
  await ensureBucket(s3, bucket, region, deploymentId, project.id);
  const releasePrefix = `releases/${deploymentId}/`;
  const uploaded = await uploadAssets(s3, bucket, deploymentId, outputDir);
  await onResources?.({ ...partialResources, ...uploaded, releasePrefix });

  try {
    const distribution = await ensureDistribution(cloudfront, bucket, region, deploymentId, releasePrefix, async (partialResources) => {
      await onResources?.({ ...partialResources, type: "S3_CLOUDFRONT" });
    });
    await onResources?.({ ...partialResources, ...distribution });
    await applyCloudFrontOriginPolicy(s3, bucket, distribution.distributionArn, region);

    const invalidation = await cloudfront.send(new CreateInvalidationCommand({
      DistributionId: distribution.distributionId,
      InvalidationBatch: {
        CallerReference: `skyforge-${deploymentId}-${Date.now()}`,
        Paths: { Quantity: 1, Items: ["/*"] },
      },
    }));
    if (!invalidation.Invalidation?.Id) throw new Error("CloudFront did not return an invalidation ID.");
    await waitUntilInvalidationCompleted(
      { client: cloudfront, maxWaitTime: Number.parseInt(process.env.CLOUDFRONT_WAIT_SECONDS || "900", 10) },
      { Id: distribution.distributionId, InvalidationId: invalidation.Invalidation.Id },
    );

    emitDeploymentLog(deploymentId, {
      stage: "DEPLOYING",
      message: `[CLOUDFRONT] HTTPS deployment is live at ${distribution.domainName}`,
      level: "success",
    });
    return { success: true, type: "S3_CLOUDFRONT", endpoint: distribution.domainName, resources: { ...distribution, type: "S3_CLOUDFRONT", region } };
  } catch (cfError) {
    emitDeploymentLog(deploymentId, {
      stage: "DEPLOYING",
      message: `[CLOUDFRONT] CloudFront notice: ${cfError.message.slice(0, 160)}. Configuring S3 Static Website Hosting...`,
      level: "warn",
    });

    await s3.send(new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false,
      },
    }));

    await s3.send(new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Sid: "PublicReadGetObject",
          Effect: "Allow",
          Principal: "*",
          Action: "s3:GetObject",
          Resource: `arn:${awsPartitionForRegion(region)}:s3:::${bucket}/*`,
        }],
      }),
    }));

    await s3.send(new PutBucketWebsiteCommand({
      Bucket: bucket,
      WebsiteConfiguration: {
        IndexDocument: { Suffix: "index.html" },
        ErrorDocument: { Key: "index.html" },
      },
    }));

    const websiteUrl = region === "us-east-1"
      ? `http://${bucket}.s3-website-us-east-1.amazonaws.com`
      : `http://${bucket}.s3-website.${region}.amazonaws.com`;

    const staticResources = {
      type: "S3_STATIC_WEBSITE",
      bucket,
      region,
      websiteUrl,
      accountId: accountId || null,
    };
    await onResources?.(staticResources);

    emitDeploymentLog(deploymentId, {
      stage: "DEPLOYING",
      message: `[S3] Static Website Hosting is LIVE at ${websiteUrl}`,
      level: "success",
    });

    return {
      success: true,
      type: "S3_STATIC_WEBSITE",
      endpoint: websiteUrl,
      resources: staticResources,
    };
  }
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
