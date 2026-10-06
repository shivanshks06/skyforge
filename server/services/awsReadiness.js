import net from "node:net";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { ECRClient, DescribeRepositoriesCommand } from "@aws-sdk/client-ecr";
import { ECSClient, ListClustersCommand } from "@aws-sdk/client-ecs";
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand } from "@aws-sdk/client-elastic-load-balancing-v2";
import { SecretsManagerClient, ListSecretsCommand } from "@aws-sdk/client-secrets-manager";
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CloudFrontClient, ListDistributionsCommand } from "@aws-sdk/client-cloudfront";
import { RDSClient, DescribeDBInstancesCommand } from "@aws-sdk/client-rds";
import { WAFV2Client, ListWebACLsCommand } from "@aws-sdk/client-wafv2";
import { ServiceQuotasClient, GetServiceQuotaCommand } from "@aws-sdk/client-service-quotas";
import prisma from "../config/db.js";
import { getAwsCredentials } from "./awsConnectionService.js";
import { projectNetwork } from "./ecsService.js";
import { runCommand } from "./commandRunner.js";

/**
 * "Is my AWS account ready to deploy?" Each check returns
 * { id, group, label, status: pass | warn | fail | info, detail, fix }.
 * Checks are read-only: nothing is created, changed or billed.
 */

const config = (credentials, region = credentials.region) => ({
  region,
  credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}) },
});
const denied = (error) => /AccessDenied|not authorized|UnauthorizedOperation|AuthorizationError/i.test(`${error?.name} ${error?.message}`);
const short = (error) => String(error?.message || error).split("\n")[0].slice(0, 180);

function reachable(host, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port: 443 });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => { socket.destroy(); resolve({ ok: true, ms: Date.now() - started }); });
    socket.once("timeout", () => { socket.destroy(); resolve({ ok: false }); });
    socket.once("error", () => resolve({ ok: false }));
  });
}

/** Seen in this user's deployment logs (e.g. the CloudFront verification error). */
async function seenInLogs(userId, pattern) {
  const rows = await prisma.$queryRaw`
    SELECT d."createdAt" FROM "Deployment" d JOIN "Project" p ON p.id = d."projectId"
    WHERE p."userId" = ${userId} AND (d.logs::text ILIKE ${`%${pattern}%`} OR coalesce(d.error, '') ILIKE ${`%${pattern}%`})
    ORDER BY d."createdAt" DESC LIMIT 1`;
  return rows[0]?.createdAt || null;
}

export async function runAwsReadiness(userId) {
  const checks = [];
  const add = (check) => checks.push(check);
  const connection = await prisma.awsConnection.findUnique({ where: { userId } });
  const github = await prisma.gitHubAccount.findUnique({ where: { userId }, select: { username: true } });

  // ---------------------------------------------------------------- this machine
  const docker = await runCommand("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15_000 }).then((result) => result.output.trim(), () => null);
  add(docker
    ? { id: "docker", group: "This computer", label: "Docker is running", status: "pass", detail: `Docker Engine ${docker}. Needed for local builds and static sites.` }
    : { id: "docker", group: "This computer", label: "Docker is running", status: "fail", detail: "Docker Desktop / Docker Engine is not running.", fix: "Start Docker Desktop. Cloud builds (Infrastructure → Where to build → In AWS) do not need it, but static sites and the local fallback do." });
  add(github
    ? { id: "github", group: "This computer", label: "GitHub connected", status: "pass", detail: `Signed in as @${github.username}.` }
    : { id: "github", group: "This computer", label: "GitHub connected", status: "warn", detail: "No GitHub login. Public repositories still work, at 60 GitHub API requests per hour.", fix: "Settings → GitHub Integration → Connect GitHub (needed for private repositories and fix pull requests)." });

  if (!connection) {
    add({ id: "aws", group: "AWS account", label: "AWS account connected", status: "fail", detail: "No AWS account is connected to SkyForge.", fix: "Settings → AWS Cloud Connection: create an IAM role with the CloudFormation template (recommended) or paste access keys." });
    return { checkedAt: new Date().toISOString(), checks, summary: summarize(checks) };
  }

  let credentials;
  try {
    credentials = await getAwsCredentials(connection);
  } catch (error) {
    add({ id: "aws", group: "AWS account", label: "AWS credentials work", status: "fail", detail: short(error), fix: "Reconnect AWS in Settings (keys may be deleted or the role's trust policy changed)." });
    return { checkedAt: new Date().toISOString(), checks, summary: summarize(checks) };
  }
  const region = credentials.region;

  // ---------------------------------------------------------------- network to the region
  const endpoints = [`sts.${region}.amazonaws.com`, `api.ecr.${region}.amazonaws.com`, `ecs.${region}.amazonaws.com`, `s3.${region}.amazonaws.com`];
  const results = await Promise.all(endpoints.map((host) => reachable(host)));
  const unreachable = endpoints.filter((_, index) => !results[index].ok);
  add(unreachable.length
    ? { id: "network", group: "AWS account", label: `This computer can reach AWS ${region}`, status: "fail", detail: `Cannot connect to ${unreachable.join(", ")}.`, fix: "Your network is blocking or dropping connections to this AWS region. Try another network (Wi-Fi/hotspot), turn a VPN on or off, or check firewall/antivirus. Deployments fail until this passes." }
    : { id: "network", group: "AWS account", label: `This computer can reach AWS ${region}`, status: "pass", detail: `All regional endpoints answered (${Math.max(...results.map((result) => result.ms))} ms slowest).` });

  // ---------------------------------------------------------------- identity
  let identity = null;
  try {
    identity = await new STSClient(config(credentials)).send(new GetCallerIdentityCommand({}));
    add({ id: "aws", group: "AWS account", label: "AWS credentials work", status: "pass", detail: `Account ${identity.Account} as ${identity.Arn.split(":").slice(5).join(":")}, region ${region} (${connection.authType === "ROLE_ARN" ? "IAM role" : "access keys"}).` });
  } catch (error) {
    add({ id: "aws", group: "AWS account", label: "AWS credentials work", status: "fail", detail: short(error), fix: "Reconnect AWS in Settings; the keys or role may no longer be valid." });
    return { checkedAt: new Date().toISOString(), checks, summary: summarize(checks) };
  }
  if (/:root$/.test(identity.Arn)) {
    add({ id: "root", group: "AWS account", label: "Not using the root user", status: "warn", detail: "SkyForge is connected with the account's root user keys.", fix: "Create an IAM role (Settings → CloudFormation template) or an IAM user, connect that instead, and delete the root access keys." });
  }

  // ---------------------------------------------------------------- network layout
  try {
    const network = await projectNetwork(credentials);
    add({ id: "vpc", group: "AWS account", label: "Network (VPC with 2 subnets)", status: "pass", detail: `${network.vpcId} (${network.cidr}) with subnets in two availability zones.` });
  } catch (error) {
    add({ id: "vpc", group: "AWS account", label: "Network (VPC with 2 subnets)", status: denied(error) ? "fail" : "fail", detail: short(error), fix: "Create the default VPC (VPC console → Actions → Create default VPC), or set AWS_VPC_ID and AWS_SUBNET_IDS on the server." });
  }

  // ---------------------------------------------------------------- permissions (read-only probes)
  const probes = [
    ["ECR (container images)", () => new ECRClient(config(credentials)).send(new DescribeRepositoriesCommand({ maxResults: 1 }))],
    ["ECS (containers)", () => new ECSClient(config(credentials)).send(new ListClustersCommand({ maxResults: 1 }))],
    ["Load balancers", () => new ElasticLoadBalancingV2Client(config(credentials)).send(new DescribeLoadBalancersCommand({ PageSize: 1 }))],
    ["Secrets Manager", () => new SecretsManagerClient(config(credentials)).send(new ListSecretsCommand({ MaxResults: 1 }))],
    ["CloudWatch Logs", () => new CloudWatchLogsClient(config(credentials)).send(new DescribeLogGroupsCommand({ limit: 1 }))],
    ["CloudFront", () => new CloudFrontClient(config(credentials, "us-east-1")).send(new ListDistributionsCommand({ MaxItems: 1 }))],
    ["RDS (managed databases)", () => new RDSClient(config(credentials)).send(new DescribeDBInstancesCommand({ MaxRecords: 20 }))],
    ["WAF (Protected tier)", () => new WAFV2Client(config(credentials)).send(new ListWebACLsCommand({ Scope: "REGIONAL", Limit: 1 }))],
  ];
  const probeResults = await Promise.all(probes.map(async ([name, run]) => {
    try {
      await run();
      return [name, null];
    } catch (error) {
      return [name, error];
    }
  }));
  const missing = probeResults.filter(([, error]) => error && denied(error)).map(([name]) => name);
  const broken = probeResults.filter(([, error]) => error && !denied(error));
  add(missing.length
    ? { id: "permissions", group: "Permissions", label: "SkyForge has the AWS permissions it needs", status: "fail", detail: `Access denied for: ${missing.join(", ")}.`, fix: "Re-create the IAM role from the latest CloudFormation template in Settings, or attach the missing permissions to your IAM user." }
    : { id: "permissions", group: "Permissions", label: "SkyForge has the AWS permissions it needs", status: broken.length ? "warn" : "pass", detail: broken.length ? `Could not check ${broken.map(([name]) => name).join(", ")}: ${short(broken[0][1])}` : "Read access confirmed for ECR, ECS, load balancers, Secrets Manager, CloudWatch Logs, CloudFront, RDS and WAF." });

  // ---------------------------------------------------------------- quotas
  const quotas = new ServiceQuotasClient(config(credentials));
  try {
    const quota = await quotas.send(new GetServiceQuotaCommand({ ServiceCode: "fargate", QuotaCode: "L-3032A538" }));
    const value = quota.Quota?.Value ?? 0;
    add({
      id: "fargate-quota", group: "Limits & verifications", label: "Fargate capacity (vCPU quota)", status: value >= 2 ? "pass" : value >= 1 ? "warn" : "fail",
      detail: `Your account may run ${value} Fargate vCPU at once (each SkyForge app uses 0.25–2).`,
      fix: value >= 2 ? undefined : "Service Quotas → AWS Fargate → \"Fargate On-Demand vCPU resource count\" → Request increase (e.g. to 6).",
    });
  } catch (error) {
    add({ id: "fargate-quota", group: "Limits & verifications", label: "Fargate capacity (vCPU quota)", status: "info", detail: denied(error) ? "SkyForge may not read Service Quotas (servicequotas:GetServiceQuota)." : short(error), fix: "Check it yourself: Service Quotas → AWS Fargate → Fargate On-Demand vCPU resource count (new accounts are sometimes limited)." });
  }

  const cloudfrontBlocked = await seenInLogs(userId, "must be verified before you can add new CloudFront");
  add(cloudfrontBlocked
    ? { id: "cloudfront", group: "Limits & verifications", label: "CloudFront enabled (free HTTPS)", status: "warn", detail: `AWS refused to create CloudFront distributions for this account (last seen ${new Date(cloudfrontBlocked).toLocaleDateString()}). CloudFront targets fall back to HTTP.`, fix: "AWS Support → Create case → Account and billing → \"Account verification for CloudFront\". Ask them to enable CloudFront distributions; then redeploy with an ECS + CloudFront or S3 + CloudFront target." }
    : { id: "cloudfront", group: "Limits & verifications", label: "CloudFront enabled (free HTTPS)", status: "info", detail: "Not tested yet: AWS only says whether CloudFront is enabled when a distribution is created. SkyForge falls back to HTTP if it is not.", fix: "New accounts often need \"Account verification for CloudFront\" from AWS Support before HTTPS targets work." });

  const codebuildBlocked = await seenInLogs(userId, "builds in queue for the account");
  add(codebuildBlocked
    ? { id: "codebuild", group: "Limits & verifications", label: "Cloud builds allowed (CodeBuild)", status: "warn", detail: `AWS refused to run CodeBuild builds (concurrent build limit 0, last seen ${new Date(codebuildBlocked).toLocaleDateString()}). SkyForge builds on this computer instead.`, fix: "Service Quotas → AWS CodeBuild → \"Concurrently running builds\" (Linux) → Request increase (e.g. to 5). If the option is not adjustable, open an AWS Support case." }
    : { id: "codebuild", group: "Limits & verifications", label: "Cloud builds allowed (CodeBuild)", status: "info", detail: "Not tested yet. If AWS refuses a cloud build, SkyForge builds on this computer automatically.", fix: "Only needed for Infrastructure → Where to build → In AWS." });

  const rdsBlocked = await seenInLogs(userId, "InstanceQuotaExceeded");
  if (rdsBlocked) add({ id: "rds-quota", group: "Limits & verifications", label: "RDS database quota", status: "warn", detail: "AWS refused to create another database (instance quota).", fix: "Service Quotas → Amazon RDS → DB instances → Request increase, or destroy unused projects." });

  return { checkedAt: new Date().toISOString(), account: identity.Account, region, checks, summary: summarize(checks) };
}

function summarize(checks) {
  const count = (status) => checks.filter((check) => check.status === status).length;
  return { pass: count("pass"), warn: count("warn"), fail: count("fail"), info: count("info"), ready: count("fail") === 0 };
}
