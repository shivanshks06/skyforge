import fs from "node:fs";
import {
  CodeBuildClient,
  BatchGetBuildsCommand,
  BatchGetProjectsCommand,
  CreateProjectCommand,
  StartBuildCommand,
  StopBuildCommand,
  UpdateProjectCommand,
} from "@aws-sdk/client-codebuild";
import {
  S3Client,
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketTaggingCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
} from "@aws-sdk/client-s3";
import { IAMClient, CreateRoleCommand, GetRoleCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CloudWatchLogsClient, GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { emitDeploymentLog } from "./logsService.js";

/**
 * Cloud builds: the container image is built by AWS CodeBuild inside the user's AWS account and
 * pushed to ECR from there, so only the (small) source archive travels over the user's network.
 *
 * Shared, account-level builder (created once, free while idle):
 *   - S3 bucket skyforge-builds-<account>-<region> (private, archives expire after 1 day)
 *   - IAM role skyforge-codebuild (read that bucket, push to skyforge-* ECR repositories, write logs)
 *   - CodeBuild project skyforge-builder (Linux, 4 vCPU / 7 GB, Docker enabled)
 * Builds cost about $0.01 per minute; the first 100 build minutes a month are free on AWS.
 */

export const BUILDER_PROJECT = "skyforge-builder";
export const BUILDER_ROLE = "skyforge-codebuild";
const LOG_GROUP = "/aws/codebuild/skyforge-builder";
const BUILD_IMAGE = "aws/codebuild/standard:7.0";
const COMPUTE = "BUILD_GENERAL1_MEDIUM";

const awsConfig = (credentials, region = credentials.region) => ({
  region,
  credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}) },
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function accountId(credentials) {
  if (/^\d{12}$/.test(credentials.accountId || "")) return credentials.accountId;
  return (await new STSClient(awsConfig(credentials)).send(new GetCallerIdentityCommand({}))).Account;
}

export const builderBucketName = (account, region) => `skyforge-builds-${account}-${region}`.slice(0, 63);

async function ensureBucket(s3, bucket, region) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return;
  } catch (error) {
    if (error.$metadata?.httpStatusCode !== 404 && error.name !== "NotFound" && error.name !== "NoSuchBucket") throw error;
  }
  await s3.send(new CreateBucketCommand({ Bucket: bucket, ...(region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: region } }) }));
  await s3.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }));
  await s3.send(new PutBucketLifecycleConfigurationCommand({
    Bucket: bucket,
    LifecycleConfiguration: { Rules: [{ ID: "expire-build-archives", Status: "Enabled", Filter: { Prefix: "" }, Expiration: { Days: 1 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }] },
  }));
  await s3.send(new PutBucketTaggingCommand({ Bucket: bucket, Tagging: { TagSet: [{ Key: "skyforge:managed", Value: "true" }, { Key: "skyforge:purpose", Value: "cloud-builds" }] } }));
}

function rolePolicy({ account, region, bucket, partition = "aws" }) {
  return {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: [`arn:${partition}:logs:${region}:${account}:log-group:${LOG_GROUP}`, `arn:${partition}:logs:${region}:${account}:log-group:${LOG_GROUP}:*`] },
      { Effect: "Allow", Action: ["s3:GetObject"], Resource: `arn:${partition}:s3:::${bucket}/*` },
      { Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: "*" },
      {
        Effect: "Allow",
        Action: ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
        Resource: `arn:${partition}:ecr:${region}:${account}:repository/skyforge-*`,
      },
    ],
  };
}

async function ensureRole(iam, policy) {
  let arn;
  let created = false;
  try {
    arn = (await iam.send(new GetRoleCommand({ RoleName: BUILDER_ROLE }))).Role.Arn;
  } catch (error) {
    if (!/NoSuchEntity/.test(error.name)) throw error;
    arn = (await iam.send(new CreateRoleCommand({
      RoleName: BUILDER_ROLE,
      Description: "SkyForge cloud builds (CodeBuild)",
      AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "codebuild.amazonaws.com" }, Action: "sts:AssumeRole" }] }),
      Tags: [{ Key: "skyforge:managed", Value: "true" }],
    }))).Role.Arn;
    created = true;
  }
  await iam.send(new PutRolePolicyCommand({ RoleName: BUILDER_ROLE, PolicyName: "SkyForgeCloudBuild", PolicyDocument: JSON.stringify(policy) }));
  return { arn, created };
}

/** Creates (once) or updates the account's shared builder. Returns { bucket, project }. */
export async function ensureCloudBuilder({ credentials, log }) {
  const region = credentials.region;
  const account = await accountId(credentials);
  const bucket = builderBucketName(account, region);
  const partition = region.startsWith("cn-") ? "aws-cn" : region.startsWith("us-gov-") ? "aws-us-gov" : "aws";
  await ensureBucket(new S3Client(awsConfig(credentials)), bucket, region);
  const role = await ensureRole(new IAMClient(awsConfig(credentials)), rolePolicy({ account, region, bucket, partition }));
  const codebuild = new CodeBuildClient(awsConfig(credentials));
  const definition = {
    name: BUILDER_PROJECT,
    description: "SkyForge: builds deployment images inside AWS and pushes them to ECR",
    source: { type: "NO_SOURCE", buildspec: "version: 0.2\nphases:\n  build:\n    commands:\n      - echo SkyForge passes the buildspec with every build\n" },
    artifacts: { type: "NO_ARTIFACTS" },
    environment: { type: "LINUX_CONTAINER", image: BUILD_IMAGE, computeType: COMPUTE, privilegedMode: true },
    serviceRole: role.arn,
    timeoutInMinutes: 60,
    queuedTimeoutInMinutes: 30,
    logsConfig: { cloudWatchLogs: { status: "ENABLED", groupName: LOG_GROUP } },
    tags: [{ key: "skyforge:managed", value: "true" }],
  };
  const existing = (await codebuild.send(new BatchGetProjectsCommand({ names: [BUILDER_PROJECT] }))).projects?.[0];
  // A brand-new role takes a few seconds before CodeBuild may use it.
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (existing) {
        const { tags, ...update } = definition;
        await codebuild.send(new UpdateProjectCommand(update));
      } else {
        await codebuild.send(new CreateProjectCommand(definition));
        log?.(`[CLOUD BUILD] Created the AWS CodeBuild builder (${BUILDER_PROJECT}) in your account. It costs nothing while idle.`);
      }
      break;
    } catch (error) {
      if (attempt >= 10 || !/InvalidInputException|not authorized|AssumeRole/i.test(`${error.name} ${error.message}`)) throw error;
      await sleep(6000);
    }
  }
  return { bucket, project: BUILDER_PROJECT, account };
}

/**
 * Docker Hub limits anonymous pulls, and CodeBuild's shared addresses hit that limit often.
 * Official images (node, python, nginx ...) are mirrored on Amazon ECR Public, so FROM and
 * COPY --from references to them are pointed there. Stage names and other registries are kept.
 */
export function useEcrPublicMirror(dockerfile) {
  const stages = new Set([...dockerfile.matchAll(/^\s*FROM\s+\S+\s+AS\s+(\S+)/gim)].map((match) => match[1].toLowerCase()));
  const mirror = (image) => {
    if (!image || image.startsWith("$") || stages.has(image.toLowerCase()) || image === "scratch") return image;
    const first = image.split("/")[0];
    const hasRegistry = image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
    if (hasRegistry) return image;
    const path = image.startsWith("library/") ? image.slice("library/".length) : image;
    if (path.includes("/")) return image; // other Docker Hub namespaces are not mirrored
    return `public.ecr.aws/docker/library/${path}`;
  };
  return dockerfile
    .replace(/^(\s*FROM\s+(?:--platform=\S+\s+)?)(\S+)/gim, (_whole, head, image) => `${head}${mirror(image)}`)
    .replace(/(--from=)(\S+)/g, (whole, head, image) => (/[:@]/.test(image) ? `${head}${mirror(image)}` : whole));
}

const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

/**
 * Uploads the build context and runs `docker build` + `docker push` in CodeBuild.
 * buildArgs: [[name, value]]. Streams the build log into the deployment log. Throws on failure
 * with the last log lines, so callers can tell network trouble from build errors.
 */
export async function runCloudBuild({ credentials, archivePath, dockerfileName, imageUri, buildArgs = [], deploymentId, isCancelled }) {
  const log = (message, level = "info") => emitDeploymentLog(deploymentId, { stage: "BUILDING", message, level });
  const builder = await ensureCloudBuilder({ credentials, log });
  const region = credentials.region;
  const key = `contexts/${deploymentId}-${Date.now()}.tar.gz`;
  const s3 = new S3Client(awsConfig(credentials));
  const size = fs.statSync(archivePath).size;
  log(`[CLOUD BUILD] Uploading the source (${(size / 1024 / 1024).toFixed(1)} MB) to your build bucket; AWS builds and stores the image from here.`);
  await s3.send(new PutObjectCommand({ Bucket: builder.bucket, Key: key, Body: fs.createReadStream(archivePath), ContentLength: size, ServerSideEncryption: "AES256" }));

  const registry = imageUri.split("/")[0];
  const argFlags = buildArgs.map(([name, value]) => `--build-arg ${shellQuote(`${name}=${value}`)}`).join(" ");
  const buildspec = [
    "version: 0.2",
    "phases:",
    "  pre_build:",
    "    commands:",
    `      - aws s3 cp ${shellQuote(`s3://${builder.bucket}/${key}`)} /tmp/context.tar.gz --only-show-errors`,
    "      - mkdir -p /tmp/context && tar -xzf /tmp/context.tar.gz -C /tmp/context",
    `      - aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${registry}`,
    "  build:",
    "    commands:",
    `      - cd /tmp/context && docker build --pull ${argFlags} -t ${shellQuote(imageUri)} -f ${shellQuote(dockerfileName)} .`,
    `      - docker push ${shellQuote(imageUri)}`,
    "",
  ].join("\n");

  const codebuild = new CodeBuildClient(awsConfig(credentials));
  const started = (await codebuild.send(new StartBuildCommand({ projectName: builder.project, buildspecOverride: buildspec }))).build;
  log(`[CLOUD BUILD] Build ${started.id.split(":").pop()} started in AWS CodeBuild (${region}).`);
  const logs = new CloudWatchLogsClient(awsConfig(credentials));
  let token;
  let streamName = null;
  const tail = [];
  const drainLogs = async () => {
    if (!streamName) return;
    for (let page = 0; page < 10; page += 1) {
      const result = await logs.send(new GetLogEventsCommand({ logGroupName: LOG_GROUP, logStreamName: streamName, startFromHead: true, ...(token ? { nextToken: token } : {}) })).catch(() => null);
      if (!result) return;
      for (const event of result.events || []) {
        for (const line of String(event.message || "").split("\n").map((text) => text.trim()).filter(Boolean)) {
          tail.push(line);
          if (tail.length > 40) tail.shift();
          log(`[CLOUD BUILD] ${line.slice(0, 240)}`, /error|failed|fatal/i.test(line) ? "warn" : "info");
        }
      }
      if (!result.nextForwardToken || result.nextForwardToken === token) return;
      token = result.nextForwardToken;
    }
  };

  try {
    for (;;) {
      await sleep(5000);
      if (await isCancelled?.()) {
        await codebuild.send(new StopBuildCommand({ id: started.id })).catch(() => {});
        throw Object.assign(new Error("Deployment cancelled; the cloud build was stopped."), { code: "DEPLOYMENT_CANCELLED" });
      }
      const build = (await codebuild.send(new BatchGetBuildsCommand({ ids: [started.id] }))).builds?.[0];
      streamName ||= build?.logs?.streamName || null;
      await drainLogs();
      if (!build || build.buildStatus === "IN_PROGRESS") continue;
      await sleep(3000);
      await drainLogs();
      if (build.buildStatus === "SUCCEEDED") {
        const seconds = Math.round((new Date(build.endTime) - new Date(build.startTime)) / 1000);
        log(`[CLOUD BUILD] Image built and pushed by AWS in ${Math.floor(seconds / 60)}m ${seconds % 60}s.`, "success");
        return { buildId: started.id, seconds };
      }
      const phase = (build.phases || []).find((item) => item.phaseStatus && item.phaseStatus !== "SUCCEEDED");
      const reason = phase?.contexts?.map((context) => context.message).filter(Boolean).join("; ") || build.buildStatus;
      throw new Error(`Cloud build ${build.buildStatus.toLowerCase()} in ${phase?.phaseType || "build"}: ${reason}\n${tail.slice(-15).join("\n")}`);
    }
  } finally {
    await s3.send(new DeleteObjectCommand({ Bucket: builder.bucket, Key: key })).catch(() => {});
  }
}
