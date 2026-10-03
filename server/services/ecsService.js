import crypto from "node:crypto";
import {
  ECSClient,
  CreateClusterCommand,
  CreateServiceCommand,
  DeleteClusterCommand,
  DeleteServiceCommand,
  DeregisterTaskDefinitionCommand,
  DescribeClustersCommand,
  DescribeServicesCommand,
  DescribeTasksCommand,
  ListTaskDefinitionsCommand,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
  waitUntilServicesStable,
  waitUntilServicesInactive,
} from "@aws-sdk/client-ecs";
import {
  ElasticLoadBalancingV2Client as ELBV2Client,
  CreateListenerCommand,
  CreateLoadBalancerCommand,
  CreateTargetGroupCommand,
  DeleteListenerCommand,
  DeleteLoadBalancerCommand,
  DeleteTargetGroupCommand,
  DescribeListenersCommand,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  ModifyTargetGroupCommand,
  ModifyTargetGroupAttributesCommand,
  DescribeTargetHealthCommand,
  ModifyLoadBalancerAttributesCommand,
  ModifyListenerCommand,
  DescribeRulesCommand,
  CreateRuleCommand,
  DeleteRuleCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import {
  EC2Client,
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  DescribeManagedPrefixListsCommand,
  RevokeSecurityGroupIngressCommand,
} from "@aws-sdk/client-ec2";
import {
  IAMClient,
  AttachRolePolicyCommand,
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  DetachRolePolicyCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { CloudFrontClient, DeleteDistributionCommand, GetDistributionCommand, UpdateDistributionCommand, waitUntilDistributionDeployed } from "@aws-sdk/client-cloudfront";
import { CloudWatchLogsClient, CreateLogGroupCommand, DeleteLogGroupCommand, DescribeLogGroupsCommand, GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { SecretsManagerClient, CreateSecretCommand, DescribeSecretCommand, PutSecretValueCommand, DeleteSecretCommand } from "@aws-sdk/client-secrets-manager";
import { emitDeploymentLog } from "./logsService.js";
import { decryptObjectValues } from "./secretService.js";
import { awsPartitionForRegion } from "./awsPartition.js";
import { deleteWebAcl, findWafLeftovers } from "./wafService.js";
import { deleteCanary, canaryExists } from "./canaryService.js";

function awsConfig(credentials) {
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) throw new Error("Valid AWS credentials are required for ECS deployment.");
  return {
    region: credentials.region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
  };
}

function appNameFor(project) {
  const base = String(project.name || "skyforge-app").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "skyforge-app";
  const stableId = crypto.createHash("sha256").update(String(project.id || "unknown")).digest("hex").slice(0, 10);
  // Leave room for the longest AWS suffix ("-alb-sg") under ALB, target-group, ECS, and IAM limits.
  return `${base.slice(0, 12)}-${stableId}`;
}

export function resourceNames(project) {
  const appName = appNameFor(project);
  return {
    appName,
    clusterName: `${appName}-cluster`,
    serviceName: `${appName}-service`,
    loadBalancerName: `${appName}-alb`,
    targetGroupName: `${appName}-tg`,
    albSecurityGroupName: `${appName}-alb-sg`,
    taskSecurityGroupName: `${appName}-task-sg`,
    executionRoleName: `${appName}-execution`,
    taskRoleName: `${appName}-task`,
    logGroupName: `/ecs/${appName}`,
  };
}

async function describeDefaultNetwork(ec2) {
  const configuredVpc = process.env.AWS_VPC_ID?.trim();
  const configuredSubnets = String(process.env.AWS_SUBNET_IDS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (Boolean(configuredVpc) !== Boolean(configuredSubnets.length)) {
    throw new Error("AWS_VPC_ID and AWS_SUBNET_IDS must be configured together.");
  }
  if (configuredSubnets.length > 0 && (configuredSubnets.length < 2 || configuredSubnets.some((id) => !/^subnet-[0-9a-f]{8,17}$/i.test(id)))) {
    throw new Error("AWS_SUBNET_IDS must contain at least two valid subnet IDs.");
  }
  if (configuredVpc && !/^vpc-[0-9a-f]{8,17}$/i.test(configuredVpc)) throw new Error("AWS_VPC_ID is invalid.");
  if (configuredVpc && configuredSubnets.length >= 2) {
    const uniqueSubnets = [...new Set(configuredSubnets)];
    if (uniqueSubnets.length < 2) throw new Error("AWS_SUBNET_IDS must contain distinct subnet IDs.");
    return { vpcId: configuredVpc, subnetIds: uniqueSubnets.slice(0, 2) };
  }

  let vpcId = configuredVpc;
  if (!vpcId) {
    const vpcs = await ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: "isDefault", Values: ["true"] }] }));
    vpcId = vpcs.Vpcs?.[0]?.VpcId;
  }
  if (!vpcId) {
    const allVpcs = await ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: "state", Values: ["available"] }] }));
    vpcId = allVpcs.Vpcs?.[0]?.VpcId;
  }
  if (!vpcId) throw new Error("No VPC is configured or available. Set AWS_VPC_ID and AWS_SUBNET_IDS or create a default VPC.");

  let subnets = await ec2.send(new DescribeSubnetsCommand({
    Filters: [{ Name: "vpc-id", Values: [vpcId] }, { Name: "default-for-az", Values: ["true"] }],
  })).catch(() => ({ Subnets: [] }));

  let selectedSubnets = [];
  const seenAzs = new Set();
  for (const subnet of subnets.Subnets || []) {
    if (!subnet.SubnetId || !subnet.AvailabilityZone || (subnet.State && subnet.State !== "available")) continue;
    if (seenAzs.has(subnet.AvailabilityZone)) continue;
    seenAzs.add(subnet.AvailabilityZone);
    selectedSubnets.push(subnet);
    if (selectedSubnets.length === 2) break;
  }

  if (selectedSubnets.length < 2) {
    selectedSubnets = [];
    seenAzs.clear();
    const allSubnets = await ec2.send(new DescribeSubnetsCommand({
      Filters: [{ Name: "vpc-id", Values: [vpcId] }, { Name: "state", Values: ["available"] }],
    })).catch(() => ({ Subnets: [] }));

    for (const subnet of allSubnets.Subnets || []) {
      if (!subnet.SubnetId || !subnet.AvailabilityZone) continue;
      if (seenAzs.has(subnet.AvailabilityZone)) continue;
      seenAzs.add(subnet.AvailabilityZone);
      selectedSubnets.push(subnet);
      if (selectedSubnets.length === 2) break;
    }
  }

  if (selectedSubnets.length < 2) throw new Error("At least two usable subnets in different availability zones are required.");
  return { vpcId, subnetIds: selectedSubnets.map((subnet) => subnet.SubnetId) };
}

async function ensureSecurityGroup(ec2, network, groupName, description, ingress, deploymentId) {
  let existing;
  try {
    existing = await ec2.send(new DescribeSecurityGroupsCommand({
      Filters: [{ Name: "group-name", Values: [groupName] }, { Name: "vpc-id", Values: [network.vpcId] }],
    }));
  } catch (error) {
    if (error.name !== "InvalidGroup.NotFound" && error.name !== "InvalidGroup.NotFoundException") throw error;
    existing = { SecurityGroups: [] };
  }
  let groupId = existing.SecurityGroups?.[0]?.GroupId;
  if (!groupId) {
    const created = await ec2.send(new CreateSecurityGroupCommand({
      GroupName: groupName,
      Description: description,
      VpcId: network.vpcId,
    }));
    groupId = created.GroupId;
  }
  try {
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId: groupId, IpPermissions: [ingress] }));
  } catch (error) {
    if (error.name !== "InvalidPermission.Duplicate") throw error;
  }
  const allowsPublic = ingress.IpRanges?.some((range) => range.CidrIp === "0.0.0.0/0");
  if (!allowsPublic) {
    const publicIngress = (existing.SecurityGroups?.[0]?.IpPermissions || []).filter((permission) =>
      permission.IpRanges?.some((range) => range.CidrIp === "0.0.0.0/0") ||
      permission.Ipv6Ranges?.some((range) => range.CidrIpv6 === "::/0")
    );
    if (publicIngress.length) {
      await ec2.send(new RevokeSecurityGroupIngressCommand({ GroupId: groupId, IpPermissions: publicIngress }));
    }
  }
  emitDeploymentLog(deploymentId, { stage: "PROVISIONING", message: `[ECS] Reconciled security group ${groupName}.`, level: "info" });
  return groupId;
}

async function ensureLoadBalancer(elbv2, network, names, deploymentId, securityGroupId) {
  let existing;
  try {
    existing = await elbv2.send(new DescribeLoadBalancersCommand({ Names: [names.loadBalancerName] }));
  } catch (error) {
    if (!error.name?.includes("LoadBalancerNotFound") && !error.message?.includes("not found")) throw error;
    existing = { LoadBalancers: [] };
  }
  let loadBalancer = existing.LoadBalancers?.[0];
  if (loadBalancer && loadBalancer.VpcId && loadBalancer.VpcId !== network.vpcId) {
    try {
      await elbv2.send(new DeleteLoadBalancerCommand({ LoadBalancerArn: loadBalancer.LoadBalancerArn }));
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      console.warn(`[ALB] Could not delete mismatched load balancer ${loadBalancer.LoadBalancerArn}:`, e.message);
    }
    loadBalancer = null;
  }
  if (!loadBalancer) {
    const created = await elbv2.send(new CreateLoadBalancerCommand({
      Name: names.loadBalancerName,
      Subnets: network.subnetIds,
      SecurityGroups: [securityGroupId],
      Scheme: "internet-facing",
      Type: "application",
      IpAddressType: "ipv4",
    }));
    loadBalancer = created.LoadBalancers?.[0];
    emitDeploymentLog(deploymentId, { stage: "PROVISIONING", message: `[ALB] Created ${names.loadBalancerName}.`, level: "info" });
  }
  if (!loadBalancer?.LoadBalancerArn || !loadBalancer?.DNSName) throw new Error("AWS did not return a usable application load balancer.");
  return { arn: loadBalancer.LoadBalancerArn, dnsName: loadBalancer.DNSName };
}

const HEALTHY_HTTP_CODES = "200-499";
// JVM, Rails and Django apps can take minutes to boot; don't kill them before they listen.
const HEALTH_CHECK_GRACE_SECONDS = 180;

async function ensureTargetGroup(elbv2, vpcId, port, healthPath, names) {
  const normalizedHealthPath = /^\/[A-Za-z0-9/_-]*$/.test(String(healthPath || "")) ? healthPath : "/";
  let existing;
  try {
    existing = await elbv2.send(new DescribeTargetGroupsCommand({ Names: [names.targetGroupName] }));
  } catch (error) {
    if (!error.name?.includes("TargetGroupNotFound") && !error.message?.includes("not found")) throw error;
    existing = { TargetGroups: [] };
  }
  let targetGroup = existing.TargetGroups?.[0];
  if (targetGroup && targetGroup.VpcId && targetGroup.VpcId !== vpcId) {
    try {
      await elbv2.send(new DeleteTargetGroupCommand({ TargetGroupArn: targetGroup.TargetGroupArn }));
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      console.warn(`[ALB] Could not delete mismatched target group ${targetGroup.TargetGroupArn}:`, e.message);
    }
    targetGroup = null;
  }
  if (!targetGroup) {
    const created = await elbv2.send(new CreateTargetGroupCommand({
      Name: names.targetGroupName,
      VpcId: vpcId,
      Port: port,
      Protocol: "HTTP",
      TargetType: "ip",
      HealthCheckProtocol: "HTTP",
      HealthCheckPort: String(port),
      HealthCheckPath: normalizedHealthPath,
      HealthyThresholdCount: 2,
      UnhealthyThresholdCount: 3,
      HealthCheckIntervalSeconds: 30,
      HealthCheckTimeoutSeconds: 10,
      Matcher: { HttpCode: HEALTHY_HTTP_CODES },
    }));
    targetGroup = created.TargetGroups?.[0];
  }
  if (!targetGroup?.TargetGroupArn) throw new Error("AWS did not return a usable target group.");
  // The 300s default drain delays every rollout and teardown; single-task services don't need it.
  await elbv2.send(new ModifyTargetGroupAttributesCommand({
    TargetGroupArn: targetGroup.TargetGroupArn,
    Attributes: [{ Key: "deregistration_delay.timeout_seconds", Value: "30" }],
  })).catch((error) => console.warn(`[ALB] Could not shorten deregistration delay: ${error.message}`));
  if (targetGroup.Port !== port || targetGroup.HealthCheckPath !== normalizedHealthPath || targetGroup.Matcher?.HttpCode !== HEALTHY_HTTP_CODES) {
    const modified = await elbv2.send(new ModifyTargetGroupCommand({
      TargetGroupArn: targetGroup.TargetGroupArn,
      Port: port,
      HealthCheckProtocol: "HTTP",
      HealthCheckPort: String(port),
      HealthCheckPath: normalizedHealthPath,
      Matcher: { HttpCode: HEALTHY_HTTP_CODES },
    }));
    return modified.TargetGroups?.[0]?.TargetGroupArn || targetGroup.TargetGroupArn;
  }
  return targetGroup.TargetGroupArn;
}

async function ensureListener(elbv2, loadBalancerArn, targetGroupArn) {
  const listeners = await elbv2.send(new DescribeListenersCommand({ LoadBalancerArn: loadBalancerArn }));
  const existing = listeners.Listeners?.find((listener) => listener.Protocol === "HTTP" && listener.Port === 80);
  if (existing?.ListenerArn) {
    const alreadyTargetsGroup = (existing.DefaultActions || []).some(
      (action) => action.Type === "forward" && (action.TargetGroupArn === targetGroupArn || action.ForwardConfig?.TargetGroupArn === targetGroupArn),
    );
    if (!alreadyTargetsGroup) {
      const modified = await elbv2.send(new ModifyListenerCommand({
        ListenerArn: existing.ListenerArn,
        DefaultActions: [{ Type: "forward", TargetGroupArn: targetGroupArn }],
      }));
      return modified.Listener?.ListenerArn || existing.ListenerArn;
    }
    return existing.ListenerArn;
  }
  const created = await elbv2.send(new CreateListenerCommand({
    LoadBalancerArn: loadBalancerArn,
    Protocol: "HTTP",
    Port: 80,
    DefaultActions: [{ Type: "forward", TargetGroupArn: targetGroupArn }],
  }));
  const listenerArn = created.Listeners?.[0]?.ListenerArn || created.Listener?.ListenerArn;
  if (!listenerArn) throw new Error("AWS did not return a listener ARN.");
  return listenerArn;
}

async function ensureExecutionRole(iam, names, deploymentId, region) {
  let executionRoleArn;
  try {
    const role = await iam.send(new GetRoleCommand({ RoleName: names.executionRoleName }));
    executionRoleArn = role.Role?.Arn;
  } catch (error) {
    if (!error.name?.includes("NoSuchEntity")) throw error;
  }
  if (!executionRoleArn) {
    const created = await iam.send(new CreateRoleCommand({
      RoleName: names.executionRoleName,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" }, Action: "sts:AssumeRole" }],
      }),
      Description: `SkyForge ECS execution role for ${names.appName}`,
    }));
    executionRoleArn = created.Role?.Arn;
    emitDeploymentLog(deploymentId, { stage: "PROVISIONING", message: `[IAM] Created ECS execution role ${names.executionRoleName}.`, level: "info" });
  }
  if (!executionRoleArn) throw new Error("AWS did not return an ECS execution role ARN.");

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await iam.send(new AttachRolePolicyCommand({
        RoleName: names.executionRoleName,
        PolicyArn: `arn:${awsPartitionForRegion(region || "us-east-1")}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy`,
      }));
      break;
    } catch (error) {
      if ((error.name?.includes("NoSuchEntity") || /cannot be found/i.test(error.message)) && attempt < 10) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw error;
    }
  }
  return executionRoleArn;
}

async function ensureTaskRole(iam, names, deploymentId) {
  try {
    const role = await iam.send(new GetRoleCommand({ RoleName: names.taskRoleName }));
    if (role.Role?.Arn) return role.Role.Arn;
  } catch (error) {
    if (!error.name?.includes("NoSuchEntity")) throw error;
  }
  const created = await iam.send(new CreateRoleCommand({
    RoleName: names.taskRoleName,
    AssumeRolePolicyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" }, Action: "sts:AssumeRole" }],
    }),
    Description: `SkyForge application task role for ${names.appName}`,
  }));
  emitDeploymentLog(deploymentId, { stage: "PROVISIONING", message: `[IAM] Created ECS task role ${names.taskRoleName}.`, level: "info" });
  return created.Role.Arn;
}

async function ensureSecret(secrets, project, deploymentId) {
  const values = decryptObjectValues(project.envConfig || {});
  const entries = Object.entries(values).filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value !== undefined && value !== null);
  if (!entries.length) return null;
  const name = `skyforge/${resourceNames(project).appName}/env`;
  const stage = `SKYFORGE_${String(deploymentId).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64)}`;
  const secretValue = JSON.stringify(Object.fromEntries(entries));
  let arn;
  let versionId;
  try {
    const described = await secrets.send(new DescribeSecretCommand({ SecretId: name }));
    arn = described.ARN;
    const version = await secrets.send(new PutSecretValueCommand({ SecretId: name, SecretString: secretValue, VersionStages: [stage] }));
    versionId = version.VersionId;
  } catch (error) {
    if (error.name !== "ResourceNotFoundException") throw error;
    const created = await secrets.send(new CreateSecretCommand({ Name: name, SecretString: secretValue }));
    arn = created.ARN;
    versionId = created.VersionId;
  }
  if (!versionId) throw new Error("Secrets Manager did not return an immutable version ID.");
  emitDeploymentLog(deploymentId, { stage: "PROVISIONING", message: `[SECRETS] Stored application environment in ${name} version ${versionId}.`, level: "info" });
  return { name, arn, versionId, stage, keys: entries.map(([key]) => key) };
}

async function ensureCluster(ecs, names, deploymentId) {
  try {
    const described = await ecs.send(new DescribeClustersCommand({ clusters: [names.clusterName] }));
    const existing = described.clusters?.[0];
    if (existing?.clusterArn && existing.status === "ACTIVE") return existing.clusterArn;
  } catch (error) {
    if (!error.name?.includes("ClusterNotFound")) throw error;
  }
  const created = await ecs.send(new CreateClusterCommand({ clusterName: names.clusterName }));
  emitDeploymentLog(deploymentId, { stage: "PROVISIONING", message: `[ECS] Created cluster ${names.clusterName}.`, level: "info" });
  return created.cluster.clusterArn;
}

async function ensureLogGroup(logs, names, deploymentId) {
  const existing = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: names.logGroupName }));
  if (existing.logGroups?.some((group) => group.logGroupName === names.logGroupName)) return names.logGroupName;
  await logs.send(new CreateLogGroupCommand({ logGroupName: names.logGroupName, retentionInDays: 7 }));
  emitDeploymentLog(deploymentId, { stage: "PROVISIONING", message: `[CLOUDWATCH] Created log group ${names.logGroupName}.`, level: "info" });
  return names.logGroupName;
}

function taskSecretKeys(project) {
  const values = decryptObjectValues(project.envConfig || {});
  return Object.keys(values).filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && values[key] !== undefined && values[key] !== null);
}

function taskDefinitionInput(project, imageUri, port, executionRoleArn, taskRoleArn, logGroupName, region, secret, extraEnvironment = {}) {
  const cpu = String(project.cpu === "0.25 vCPU" ? 256 : project.cpu === "1 vCPU" ? 1024 : project.cpu === "2 vCPU" ? 2048 : 512);
  const memory = String(project.memory === "512 MB" ? 512 : project.memory === "2 GB" ? 2048 : project.memory === "4 GB" ? 4096 : 1024);
  return {
    family: resourceNames(project).appName,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu,
    memory,
    executionRoleArn,
    taskRoleArn,
    containerDefinitions: [{
      name: resourceNames(project).appName,
      image: imageUri,
      essential: true,
      portMappings: [{ containerPort: port, hostPort: port, protocol: "tcp" }],
      // Most frameworks read PORT/HOST; binding 0.0.0.0 is required for the load balancer to reach them.
      environment: [["PORT", String(port)], ["HOST", "0.0.0.0"], ...Object.entries(extraEnvironment)]
        .filter(([name]) => !secret?.keys?.includes(name))
        .map(([name, value]) => ({ name, value })),
      secrets: secret ? secret.keys.map((name) => ({ name, valueFrom: `${secret.arn}:${name}::${secret.versionId}` })) : [],
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-group": logGroupName,
          "awslogs-region": region,
          "awslogs-stream-prefix": "ecs",
        },
      },
    }],
  };
}

async function describeService(ecs, cluster, service) {
  try {
    const result = await ecs.send(new DescribeServicesCommand({ cluster, services: [service], include: ["TAGS"] }));
    return result.services?.[0] || null;
  } catch (error) {
    if (error.name === "ServiceNotFoundException" || error.name === "ServiceNotFound") return null;
    throw error;
  }
}

export async function deployToEcs({ deploymentId, project, credentials, imageUri, onResources, extraEnvironment = {} }) {
  const config = awsConfig(credentials);
  const region = credentials.region || process.env.AWS_REGION || "ap-south-1";
  const ecs = new ECSClient(config);
  const elbv2 = new ELBV2Client(config);
  const ec2 = new EC2Client(config);
  const iam = new IAMClient(config);
  const logs = new CloudWatchLogsClient(config);
  const secrets = new SecretsManagerClient(config);
  const names = resourceNames(project);
  const port = Number.parseInt(project.port || 3000, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Project port is invalid for ECS.");

  const resources = {
    type: "ECS_FARGATE",
    clusterName: names.clusterName,
    serviceName: names.serviceName,
    executionRoleName: names.executionRoleName,
    taskRoleName: names.taskRoleName,
    taskDefinitionFamily: names.appName,
    logGroupName: names.logGroupName,
    secretName: `skyforge/${names.appName}/env`,
    loadBalancerName: names.loadBalancerName,
    targetGroupName: names.targetGroupName,
    albSecurityGroupName: names.albSecurityGroupName,
    taskSecurityGroupName: names.taskSecurityGroupName,
    imageUri,
    region,
    accountId: credentials.accountId || process.env.AWS_ACCOUNT_ID || null,
  };
  const checkpoint = async () => onResources?.({ ...resources });

  // Persist deterministic resource names before the first create call. A lost
  // AWS response must not erase the identities needed for later teardown.
  await checkpoint();
  emitDeploymentLog(deploymentId, { stage: "PROVISIONING", message: `[AWS] Provisioning ECS resources in ${region}...`, level: "info" });
  const network = await describeDefaultNetwork(ec2);
  const albIngress = { IpProtocol: "tcp", FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "Public HTTP Ingress" }] };
  emitDeploymentLog(deploymentId, { stage: "PROVISIONING", message: `[ALB] Configuring direct public HTTP ingress on port 80.`, level: "info" });

  const albSecurityGroupId = await ensureSecurityGroup(
    ec2,
    network,
    names.albSecurityGroupName,
    `SkyForge ALB ${names.appName}`,
    albIngress,
    deploymentId,
  );
  resources.albSecurityGroupId = albSecurityGroupId;
  await checkpoint();
  const taskSecurityGroupId = await ensureSecurityGroup(
    ec2,
    network,
    names.taskSecurityGroupName,
    `SkyForge task ${names.appName}`,
    { IpProtocol: "tcp", FromPort: port, ToPort: port, UserIdGroupPairs: [{ GroupId: albSecurityGroupId }] },
    deploymentId,
  );
  resources.taskSecurityGroupId = taskSecurityGroupId;
  await checkpoint();
  const loadBalancer = await ensureLoadBalancer(elbv2, network, names, deploymentId, albSecurityGroupId);
  resources.loadBalancerArn = loadBalancer.arn;
  resources.loadBalancerDns = loadBalancer.dnsName;
  await checkpoint();
  await elbv2.send(new ModifyLoadBalancerAttributesCommand({
    LoadBalancerArn: loadBalancer.arn,
    Attributes: [{ Key: "routing.http.drop_invalid_header_fields.enabled", Value: "true" }],
  })).catch((error) => emitDeploymentLog(deploymentId, { stage: "PROVISIONING", message: `[ALB] Header hardening skipped: ${error.message.slice(0, 120)}`, level: "warn" }));
  const targetGroupArn = await ensureTargetGroup(elbv2, network.vpcId, port, project.healthCheck || "/", names);
  resources.targetGroupArn = targetGroupArn;
  await checkpoint();
  const listenerArn = await ensureListener(elbv2, loadBalancer.arn, targetGroupArn);
  resources.listenerArn = listenerArn;
  await checkpoint();
  const executionRoleArn = await ensureExecutionRole(iam, names, deploymentId, region);
  resources.executionRoleArn = executionRoleArn;
  await checkpoint();
  const taskRoleArn = await ensureTaskRole(iam, names, deploymentId);
  resources.taskRoleArn = taskRoleArn;
  await checkpoint();
  const secret = await ensureSecret(secrets, project, deploymentId);
  resources.secretName = secret?.name || null;
  resources.secretArn = secret?.arn || null;
  resources.secretVersionId = secret?.versionId || null;
  await checkpoint();
  if (secret) {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      try {
        await iam.send(new PutRolePolicyCommand({
          RoleName: names.executionRoleName,
          PolicyName: "SkyForgeSecretRead",
          PolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: secret.arn }],
          }),
        }));
        break;
      } catch (error) {
        if ((error.name?.includes("NoSuchEntity") || /cannot be found/i.test(error.message)) && attempt < 10) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        throw error;
      }
    }
  }
  const clusterArn = await ensureCluster(ecs, names, deploymentId);
  resources.clusterArn = clusterArn;
  await checkpoint();
  const logGroupName = await ensureLogGroup(logs, names, deploymentId);
  await checkpoint();

  let taskDefinition;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      taskDefinition = await ecs.send(new RegisterTaskDefinitionCommand(taskDefinitionInput(project, imageUri, port, executionRoleArn, taskRoleArn, logGroupName, region, secret, extraEnvironment)));
      break;
    } catch (error) {
      if ((error.name === "ClientException" || /role.*cannot be assumed|invalid execution role/i.test(error.message)) && attempt < 10) {
        emitDeploymentLog(deploymentId, { stage: "PROVISIONING", message: `[IAM] Waiting for IAM execution role to propagate across AWS STS (attempt ${attempt}/10)...`, level: "info" });
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw error;
    }
  }
  if (!taskDefinition?.taskDefinition?.taskDefinitionArn) throw new Error("ECS did not return a task definition ARN.");
  const taskDefinitionArn = taskDefinition.taskDefinition.taskDefinitionArn;
  resources.taskDefinitionArn = taskDefinitionArn;
  await checkpoint();

  let service = await describeService(ecs, names.clusterName, names.serviceName);
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      if (service && service.status === "ACTIVE") {
        await ecs.send(new UpdateServiceCommand({
          cluster: names.clusterName,
          service: names.serviceName,
          taskDefinition: taskDefinitionArn,
          desiredCount: 1,
          healthCheckGracePeriodSeconds: HEALTH_CHECK_GRACE_SECONDS,
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: network.subnetIds,
              securityGroups: [taskSecurityGroupId],
              assignPublicIp: "ENABLED",
            },
          },
          loadBalancers: [{ targetGroupArn, containerName: names.appName, containerPort: port }],
        }));
      } else {
        await ecs.send(new CreateServiceCommand({
          cluster: names.clusterName,
          serviceName: names.serviceName,
          taskDefinition: taskDefinitionArn,
          desiredCount: 1,
          launchType: "FARGATE",
          platformVersion: "LATEST",
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: network.subnetIds,
              securityGroups: [taskSecurityGroupId],
              assignPublicIp: "ENABLED",
            },
          },
          loadBalancers: [{ targetGroupArn, containerName: names.appName, containerPort: port }],
          healthCheckGracePeriodSeconds: HEALTH_CHECK_GRACE_SECONDS,
          enableExecuteCommand: false,
        }));
      }
      break;
    } catch (error) {
      if (/service linked role/i.test(error.message) && attempt < 10) {
        emitDeploymentLog(deploymentId, { stage: "DEPLOYING", message: `[ECS] Waiting for AWS ECS service linked role to propagate (attempt ${attempt}/10)...`, level: "info" });
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }
      throw error;
    }
  }

  await waitForServiceRollout({ ecs, logs, names, taskDefinitionArn, deploymentId });
  service = await describeService(ecs, names.clusterName, names.serviceName);
  if (!service || service.status !== "ACTIVE") throw new Error("ECS service did not reach ACTIVE state.");

  const endpoint = `http://${loadBalancer.dnsName}`;
  emitDeploymentLog(deploymentId, {
    stage: "DEPLOYING",
    message: `[ALB] Application Load Balancer endpoint ready at ${endpoint}`,
    level: "info",
  });
  emitDeploymentLog(deploymentId, { stage: "DEPLOYING", message: `[ECS] Service ${names.serviceName} is stable with task definition ${taskDefinitionArn}.`, level: "success" });
  return {
    success: true,
    type: "ECS_FARGATE",
    endpoint,
    resources,
  };
}

async function recentContainerLogs(logs, logGroupName, logStreamName) {
  try {
    const result = await logs.send(new GetLogEventsCommand({ logGroupName, logStreamName, limit: 15, startFromHead: false }));
    return (result.events || []).map((event) => String(event.message || "").trimEnd()).filter(Boolean);
  } catch {
    return []; // logs:GetLogEvents may not be granted; the stop reason is still reported.
  }
}

// Replaces the SDK waiter, which polls silently for up to ECS_WAIT_SECONDS even when every new
// task crashes on boot. Reports progress and fails fast with the container's own exit reason.
async function waitForServiceRollout({ ecs, logs, names, taskDefinitionArn, deploymentId, maxFailedTasks = 3 }) {
  const deadline = Date.now() + Number.parseInt(process.env.ECS_WAIT_SECONDS || "900", 10) * 1000;
  const startedAt = Date.now();
  const checkedTasks = new Set();
  let failedTasks = 0;
  let lastProgress = "";
  while (Date.now() < deadline) {
    const service = await describeService(ecs, names.clusterName, names.serviceName);
    const primary = service?.deployments?.find((entry) => entry.status === "PRIMARY");
    // ECS stops older revisions only after the new tasks pass load balancer health checks.
    const olderStillServing = service?.deployments?.some((entry) => entry !== primary && entry.runningCount > 0);
    if (primary && primary.desiredCount > 0 && primary.runningCount === primary.desiredCount && primary.pendingCount === 0
      && (primary.rolloutState === "COMPLETED" || !olderStillServing)) return;

    const progress = `[ECS] Waiting for ${primary?.runningCount ?? 0}/${primary?.desiredCount ?? 1} healthy task(s); ${primary?.pendingCount ?? 0} starting, ${service?.deployments?.length || 0} deployment(s) active.`;
    if (progress !== lastProgress) {
      emitDeploymentLog(deploymentId, { stage: "DEPLOYING", message: progress, level: "info" });
      lastProgress = progress;
    }

    const stoppedArns = (await ecs.send(new ListTasksCommand({ cluster: names.clusterName, desiredStatus: "STOPPED" }))).taskArns || [];
    const fresh = stoppedArns.filter((arn) => !checkedTasks.has(arn));
    if (fresh.length) {
      const { tasks = [] } = await ecs.send(new DescribeTasksCommand({ cluster: names.clusterName, tasks: fresh.slice(0, 100) }));
      for (const arn of fresh) checkedTasks.add(arn);
      for (const task of tasks) {
        // Only count tasks from this rollout, not earlier revisions ECS is still draining.
        if (task.taskDefinitionArn !== taskDefinitionArn || (task.createdAt && task.createdAt.getTime() < startedAt - 60_000)) continue;
        failedTasks += 1;
        const container = task.containers?.[0];
        const reason = `${task.stoppedReason || task.stopCode || "Task stopped"}${container?.exitCode !== undefined ? ` (exit code ${container.exitCode})` : ""}${container?.reason ? `: ${container.reason}` : ""}`;
        emitDeploymentLog(deploymentId, { stage: "DEPLOYING", message: `[ECS] Task ${task.taskArn.split("/").pop()} stopped: ${reason}`, level: "warn" });
        if (failedTasks >= maxFailedTasks) {
          const taskId = task.taskArn.split("/").pop();
          const tail = await recentContainerLogs(logs, names.logGroupName, `ecs/${names.appName}/${taskId}`);
          for (const line of tail) emitDeploymentLog(deploymentId, { stage: "DEPLOYING", message: `[APP] ${line.slice(0, 240)}`, level: "error" });
          throw new Error(`The container failed to start ${failedTasks} times. Last stop: ${reason}. Check the application logs in CloudWatch log group ${names.logGroupName}.`);
        }
      }
    }
    await sleep(15_000);
  }
  throw new Error(`ECS service ${names.serviceName} did not become stable within ${process.env.ECS_WAIT_SECONDS || "900"} seconds.`);
}

export async function rollbackEcs({ credentials, resources, previousTaskDefinitionArn }) {
  if (!resources?.clusterName || !resources?.serviceName || !previousTaskDefinitionArn) {
    throw new Error("No previous ECS task definition is available for rollback.");
  }
  const ecs = new ECSClient(awsConfig(credentials));
  const service = await describeService(ecs, resources.clusterName, resources.serviceName);
  if (!service) throw new Error("The ECS service no longer exists.");
  await ecs.send(new UpdateServiceCommand({
    cluster: resources.clusterName,
    service: resources.serviceName,
    taskDefinition: previousTaskDefinitionArn,
    desiredCount: 1,
  }));
  await waitUntilServicesStable(
    { client: ecs, maxWaitTime: Number.parseInt(process.env.ECS_WAIT_SECONDS || "900", 10) },
    { cluster: resources.clusterName, services: [resources.serviceName] },
  );
  return { success: true, taskDefinitionArn: previousTaskDefinitionArn };
}

function isMissingResourceError(error) {
  return error?.$metadata?.httpStatusCode === 404
    || /NoSuch|NotFound|not found|not active|inactive|does not exist|ClusterNotFound|ServiceNotFound|TargetGroupNotFound|LoadBalancerNotFound|InvalidGroup\.NotFound/i.test(`${error?.name || ""} ${error?.message || ""}`);
}

async function ignoreMissing(promise) {
  try {
    await promise;
  } catch (error) {
    if (!isMissingResourceError(error)) throw error;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Deleting a service with force flips its tasks to STOPPED immediately, but the tasks keep
// their network interfaces (and so their security group) until they finish stopping.
async function waitForClusterTasksStopped(ecs, cluster, timeoutMs = 5 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const taskArns = [];
    for (const desiredStatus of ["RUNNING", "STOPPED"]) {
      const listed = await ecs.send(new ListTasksCommand({ cluster, desiredStatus })).catch((error) => {
        if (isMissingResourceError(error)) return { taskArns: [] };
        throw error;
      });
      taskArns.push(...(listed.taskArns || []));
    }
    if (!taskArns.length) return;
    const described = await ecs.send(new DescribeTasksCommand({ cluster, tasks: taskArns.slice(0, 100) }));
    if ((described.tasks || []).every((task) => task.lastStatus === "STOPPED")) return;
    await sleep(5000);
  }
}

// Fargate and ALB network interfaces detach asynchronously, often minutes after their owner
// is deleted; until then EC2 rejects the delete with DependencyViolation ("has a dependent object").
async function deleteSecurityGroupWhenReleased(ec2, groupId, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await ignoreMissing(ec2.send(new DeleteSecurityGroupCommand({ GroupId: groupId })));
      return;
    } catch (error) {
      const inUse = error.name === "DependencyViolation" || /dependen|in use/i.test(error.message);
      if (!inUse || Date.now() >= deadline) throw error;
      await sleep(Math.min(attempt * 2000, 15_000));
    }
  }
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

export async function destroyEcsResources({ credentials, resources, deploymentId }) {
  if (!resources?.type || resources.type !== "ECS_FARGATE") return;
  const config = awsConfig(credentials);
  const ecs = new ECSClient(config);
  const elbv2 = new ELBV2Client(config);
  const ec2 = new EC2Client(config);
  const iam = new IAMClient(config);
  const logs = new CloudWatchLogsClient(config);
  const secrets = new SecretsManagerClient(config);
  const cloudfront = new CloudFrontClient(config);

  if (resources.edgeDistributionId) {
    try {
      let edge = await cloudfront.send(new GetDistributionCommand({ Id: resources.edgeDistributionId }));
      if (edge.Distribution?.Config?.Enabled) {
        await cloudfront.send(new UpdateDistributionCommand({
          Id: resources.edgeDistributionId,
          IfMatch: edge.ETag,
          DistributionConfig: { ...edge.Distribution.Config, Enabled: false },
        }));
        await waitUntilDistributionDeployed(
          { client: cloudfront, maxWaitTime: Number.parseInt(process.env.CLOUDFRONT_WAIT_SECONDS || "900", 10) },
          { Id: resources.edgeDistributionId },
        );
        edge = await cloudfront.send(new GetDistributionCommand({ Id: resources.edgeDistributionId }));
      }
      await cloudfront.send(new DeleteDistributionCommand({ Id: resources.edgeDistributionId, IfMatch: edge.ETag }));
      await verifyResourceAbsent(async () => {
        const pending = await cloudfront.send(new GetDistributionCommand({ Id: resources.edgeDistributionId }));
        return Boolean(pending.Distribution);
      }, `CloudFront distribution ${resources.edgeDistributionId}`);
    } catch (error) {
      if (!error.name?.includes("NoSuch") && !error.name?.includes("NotFound")) throw error;
    }
  }

  if (resources.serviceName && resources.clusterName) {
    try {
      await ecs.send(new UpdateServiceCommand({ cluster: resources.clusterName, service: resources.serviceName, desiredCount: 0 })).catch((error) => {
        if (!isMissingResourceError(error)) throw error;
      });
      let waitForDeletion = true;
      await ecs.send(new DeleteServiceCommand({ cluster: resources.clusterName, service: resources.serviceName, force: true })).catch((error) => {
        if (!isMissingResourceError(error)) throw error;
        waitForDeletion = false;
      });
      if (waitForDeletion) {
        for (let i = 0; i < 30; i += 1) {
          const svc = await describeService(ecs, resources.clusterName, resources.serviceName).catch(() => null);
          if (!svc || svc.status === "INACTIVE") break;
          await sleep(2000);
        }
      }
      await waitForClusterTasksStopped(ecs, resources.clusterName);
    } catch (err) {
      if (!isMissingResourceError(err)) console.warn(`[DESTROY] ECS service ${resources.serviceName} teardown:`, err.message);
    }
  }

  if (resources.clusterName) {
    try {
      await ignoreMissing(ecs.send(new DeleteClusterCommand({ cluster: resources.clusterName })));
    } catch (err) {
      if (!isMissingResourceError(err)) console.warn(`[DESTROY] ECS cluster ${resources.clusterName} teardown:`, err.message);
    }
  }

  // Protected-tier firewall and canary user must go before the load balancer they reference.
  const appName = resources.appName || (resources.clusterName || "").replace(/-cluster$/, "");
  if (resources.webAclArn || resources.webAclId || resources.ipSetId) {
    await deleteWebAcl({ credentials, appName, loadBalancerArn: resources.loadBalancerArn, webAclId: resources.webAclId, ipSetId: resources.ipSetId });
    emitDeploymentLog(deploymentId, { stage: "DESTROY", message: "[WAF] Firewall and ban list deleted.", level: "success" });
  }
  if (resources.canaryUserName) {
    await deleteCanary({ credentials, appName, userName: resources.canaryUserName });
    emitDeploymentLog(deploymentId, { stage: "DESTROY", message: "[CANARY] Canary IAM user and key deleted.", level: "success" });
  }

  if (resources.loadBalancerArn) {
    try {
      // Disconnect all listeners first so target group is freed immediately
      const listeners = await elbv2.send(new DescribeListenersCommand({ LoadBalancerArn: resources.loadBalancerArn })).catch(() => ({ Listeners: [] }));
      for (const l of listeners.Listeners || []) {
        await ignoreMissing(elbv2.send(new DeleteListenerCommand({ ListenerArn: l.ListenerArn })));
      }
    } catch {}
    await ignoreMissing(elbv2.send(new DeleteLoadBalancerCommand({ LoadBalancerArn: resources.loadBalancerArn })));
    await verifyResourceAbsent(async () => {
      const result = await elbv2.send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [resources.loadBalancerArn] }));
      return Boolean(result.LoadBalancers?.length);
    }, `ALB ${resources.loadBalancerArn}`).catch(() => {});
  } else if (resources.listenerArn) {
    await ignoreMissing(elbv2.send(new DeleteListenerCommand({ ListenerArn: resources.listenerArn })));
  }

  if (resources.targetGroupArn) {
    for (let attempt = 1; attempt <= 25; attempt += 1) {
      try {
        await ignoreMissing(elbv2.send(new DeleteTargetGroupCommand({ TargetGroupArn: resources.targetGroupArn })));
        break;
      } catch (tgError) {
        if (attempt < 25 && (tgError.name === "ResourceInUseException" || /in use/i.test(tgError.message))) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        if (!isMissingResourceError(tgError)) throw tgError;
      }
    }
  }

  // The task group references the ALB group in its ingress rule, so it must go first.
  if (resources.taskSecurityGroupId) await deleteSecurityGroupWhenReleased(ec2, resources.taskSecurityGroupId);
  if (resources.albSecurityGroupId) await deleteSecurityGroupWhenReleased(ec2, resources.albSecurityGroupId);

  if (resources.logGroupName) await ignoreMissing(logs.send(new DeleteLogGroupCommand({ logGroupName: resources.logGroupName })));
  if (resources.secretArn || resources.secretName) {
    await ignoreMissing(secrets.send(new DeleteSecretCommand({ SecretId: resources.secretArn || resources.secretName, ForceDeleteWithoutRecovery: true })));
  }
  if (resources.taskRoleName) await ignoreMissing(iam.send(new DeleteRoleCommand({ RoleName: resources.taskRoleName })));
  if (resources.executionRoleName) {
    await iam.send(new DeleteRolePolicyCommand({ RoleName: resources.executionRoleName, PolicyName: "SkyForgeSecretRead" })).catch((error) => {
      if (!isMissingResourceError(error)) throw error;
    });
    await iam.send(new DetachRolePolicyCommand({ RoleName: resources.executionRoleName, PolicyArn: `arn:${awsPartitionForRegion(resources.region || "us-east-1")}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy` })).catch((error) => {
      if (!isMissingResourceError(error)) throw error;
    });
    await ignoreMissing(iam.send(new DeleteRoleCommand({ RoleName: resources.executionRoleName })));
  }
  if (resources.taskDefinitionArn) {
    const family = resources.taskDefinitionArn.split("/").pop()?.split(":")[0];
    if (family) {
      const definitions = await ecs.send(new ListTaskDefinitionsCommand({ familyPrefix: family, status: "ACTIVE" }));
      await Promise.all((definitions.taskDefinitionArns || []).map((arn) => ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: arn }))));
    }
  }

  if (resources.serviceName && resources.clusterName) {
    // A deleted service stays DRAINING until its tasks stop and deregister, which can take minutes.
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      const s = await describeService(ecs, resources.clusterName, resources.serviceName).catch((error) => (isMissingResourceError(error) ? null : Promise.reject(error)));
      if (!s || s.status === "INACTIVE") break;
      if (Date.now() > deadline) throw new Error(`ECS service ${resources.serviceName} still exists after deletion.`);
      await sleep(10_000);
    }
  }
  if (resources.clusterName) {
    await verifyResourceAbsent(async () => {
      const result = await ecs.send(new DescribeClustersCommand({ clusters: [resources.clusterName] }));
      // AWS may continue returning a deleted cluster as INACTIVE during
      // eventual-consistency cleanup. An inactive cluster no longer owns
      // running ECS capacity and should not block teardown completion.
      return Boolean(result.clusters?.some((cluster) => cluster.clusterArn && cluster.status === "ACTIVE"));
    }, `ECS cluster ${resources.clusterName}`);
  }
  if (resources.listenerArn) {
    await verifyResourceAbsent(async () => {
      const result = await elbv2.send(new DescribeListenersCommand({ ListenerArns: [resources.listenerArn] }));
      return Boolean(result.Listeners?.length);
    }, `load balancer listener ${resources.listenerArn}`);
  }
  if (resources.targetGroupArn) {
    await verifyResourceAbsent(async () => {
      const result = await elbv2.send(new DescribeTargetGroupsCommand({ TargetGroupArns: [resources.targetGroupArn] }));
      return Boolean(result.TargetGroups?.length);
    }, `load balancer target group ${resources.targetGroupArn}`);
  }
  if (resources.loadBalancerArn) {
    await verifyResourceAbsent(async () => {
      const result = await elbv2.send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [resources.loadBalancerArn] }));
      return Boolean(result.LoadBalancers?.length);
    }, `load balancer ${resources.loadBalancerArn}`);
  }
  for (const [label, groupIds] of [
    ["task", [resources.taskSecurityGroupId]],
    ["load balancer", [resources.albSecurityGroupId]],
  ]) {
    const ids = groupIds.filter(Boolean);
    if (!ids.length) continue;
    await verifyResourceAbsent(async () => {
      const result = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: ids }));
      return Boolean(result.SecurityGroups?.length);
    }, `${label} security group ${ids.join(", ")}`);
  }
  if (resources.logGroupName) {
    await verifyResourceAbsent(async () => {
      const result = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: resources.logGroupName }));
      return Boolean(result.logGroups?.some((group) => group.logGroupName === resources.logGroupName));
    }, `CloudWatch log group ${resources.logGroupName}`);
  }
  if (resources.secretArn || resources.secretName) {
    const secretId = resources.secretArn || resources.secretName;
    await verifyResourceAbsent(async () => {
      const result = await secrets.send(new DescribeSecretCommand({ SecretId: secretId }));
      return Boolean(result.ARN || result.Name);
    }, `Secrets Manager secret ${secretId}`);
  }
  for (const roleName of [resources.taskRoleName, resources.executionRoleName].filter(Boolean)) {
    await verifyResourceAbsent(async () => {
      const result = await iam.send(new GetRoleCommand({ RoleName: roleName }));
      return Boolean(result.Role?.Arn);
    }, `IAM role ${roleName}`);
  }
  if (resources.taskDefinitionArn) {
    const family = resources.taskDefinitionArn.split("/").pop()?.split(":")[0];
    if (family) {
      await verifyResourceAbsent(async () => {
        const result = await ecs.send(new ListTaskDefinitionsCommand({ familyPrefix: family, status: "ACTIVE" }));
        return Boolean(result.taskDefinitionArns?.length);
      }, `ECS task definition family ${family}`);
    }
  }
  emitDeploymentLog(deploymentId, { stage: "DESTROY", message: "[ECS] ECS resources were removed and verified for deletion.", level: "success" });
}

/** AWS's own view: true when the load balancer reports at least one healthy target. */
export async function loadBalancerTargetsHealthy({ credentials, targetGroupArn }) {
  if (!targetGroupArn) return false;
  const elbv2 = new ELBV2Client(awsConfig(credentials));
  const result = await elbv2.send(new DescribeTargetHealthCommand({ TargetGroupArn: targetGroupArn }));
  return (result.TargetHealthDescriptions || []).some((target) => target.TargetHealth?.State === "healthy");
}

const MAINTENANCE_PAGE = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Temporarily offline</title><style>body{font-family:system-ui,sans-serif;background:#faf8f5;color:#362217;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center;padding:24px}h1{font-size:1.6rem}p{color:#5e4c3e}</style></head><body><main><h1>This site is temporarily offline</h1><p>It will be back soon. Please check again later.</p></main></body></html>";

async function listenerFor(elbv2, resources) {
  if (resources.listenerArn) return resources.listenerArn;
  const listeners = await elbv2.send(new DescribeListenersCommand({ LoadBalancerArn: resources.loadBalancerArn }));
  return listeners.Listeners?.find((listener) => listener.Port === 80)?.ListenerArn;
}

/**
 * Takes the site offline without destroying it: the load balancer serves a maintenance page and
 * the service scales to zero tasks (no container charges; the load balancer still bills hourly).
 */
export async function takeSiteOffline({ credentials, resources }) {
  const config = awsConfig(credentials);
  const elbv2 = new ELBV2Client(config);
  const listenerArn = await listenerFor(elbv2, resources);
  if (!listenerArn) throw new Error("The load balancer listener for this site was not found.");
  await elbv2.send(new ModifyListenerCommand({
    ListenerArn: listenerArn,
    DefaultActions: [{ Type: "fixed-response", FixedResponseConfig: { StatusCode: "503", ContentType: "text/html", MessageBody: MAINTENANCE_PAGE } }],
  }));
  await new ECSClient(config).send(new UpdateServiceCommand({ cluster: resources.clusterName, service: resources.serviceName, desiredCount: 0 }));
}

/** Starts the container again; traffic switches back once the load balancer reports it healthy. */
export async function startSiteTasks({ credentials, resources }) {
  await new ECSClient(awsConfig(credentials)).send(new UpdateServiceCommand({ cluster: resources.clusterName, service: resources.serviceName, desiredCount: 1 }));
}

/** Routes traffic back to the app when a healthy target exists. Returns true once switched. */
export async function routeTrafficToAppWhenHealthy({ credentials, resources }) {
  const elbv2 = new ELBV2Client(awsConfig(credentials));
  const listenerArn = await listenerFor(elbv2, resources);
  // While the maintenance page is the default action, the target group is attached to no rule and
  // AWS never health-checks it ("unused"). A warm-up rule for an unroutable host keeps it in use,
  // so traffic switches back only once the restarted container is genuinely healthy.
  const rules = await elbv2.send(new DescribeRulesCommand({ ListenerArn: listenerArn }));
  let warmup = rules.Rules?.find((rule) => rule.Conditions?.some((condition) => condition.HostHeaderConfig?.Values?.includes(WARMUP_HOST)));
  if (!warmup) {
    warmup = (await elbv2.send(new CreateRuleCommand({
      ListenerArn: listenerArn,
      Priority: 1,
      Conditions: [{ Field: "host-header", HostHeaderConfig: { Values: [WARMUP_HOST] } }],
      Actions: [{ Type: "forward", TargetGroupArn: resources.targetGroupArn }],
    }))).Rules?.[0];
  }
  const health = await elbv2.send(new DescribeTargetHealthCommand({ TargetGroupArn: resources.targetGroupArn }));
  if (!(health.TargetHealthDescriptions || []).some((target) => target.TargetHealth?.State === "healthy")) return false;
  await elbv2.send(new ModifyListenerCommand({ ListenerArn: listenerArn, DefaultActions: [{ Type: "forward", TargetGroupArn: resources.targetGroupArn }] }));
  if (warmup?.RuleArn) await elbv2.send(new DeleteRuleCommand({ RuleArn: warmup.RuleArn })).catch(() => {});
  return true;
}

const WARMUP_HOST = "skyforge-warmup.invalid";

/**
 * Finds every AWS resource that belongs to the project by its SkyForge name prefix, whether or not a
 * deployment recorded it (e.g. a deploy that crashed mid-way). Returns a destroyable manifest and a
 * human-readable list; an empty list means nothing is left.
 */
export async function discoverProjectResources({ credentials, project, repositoryName }) {
  const config = awsConfig(credentials);
  const names = resourceNames(project);
  const ecs = new ECSClient(config);
  const elbv2 = new ELBV2Client(config);
  const ec2 = new EC2Client(config);
  const iam = new IAMClient(config);
  const logs = new CloudWatchLogsClient(config);
  const secrets = new SecretsManagerClient(config);
  const manifest = { type: "ECS_FARGATE", appName: names.appName, region: credentials.region };
  const found = [];
  const soft = (promise) => promise.catch((error) => {
    if (isMissingResourceError(error) || /NoSuchEntity|ResourceNotFound|LoadBalancerNotFound|TargetGroupNotFound|InvalidGroup/.test(error.name)) return null;
    throw error;
  });

  const clusters = await soft(ecs.send(new DescribeClustersCommand({ clusters: [names.clusterName] })));
  if (clusters?.clusters?.some((cluster) => cluster.status === "ACTIVE")) {
    manifest.clusterName = names.clusterName;
    found.push(`ECS cluster ${names.clusterName}`);
    const service = await describeService(ecs, names.clusterName, names.serviceName).catch(() => null);
    if (service && service.status !== "INACTIVE") {
      manifest.serviceName = names.serviceName;
      found.push(`ECS service ${names.serviceName} (${service.runningCount} running)`);
    }
  }
  const definitions = await soft(ecs.send(new ListTaskDefinitionsCommand({ familyPrefix: names.appName, status: "ACTIVE" })));
  if (definitions?.taskDefinitionArns?.length) {
    manifest.taskDefinitionArn = definitions.taskDefinitionArns.at(-1);
    found.push(`${definitions.taskDefinitionArns.length} ECS task definition revision(s)`);
  }
  const balancers = await soft(elbv2.send(new DescribeLoadBalancersCommand({ Names: [names.loadBalancerName] })));
  if (balancers?.LoadBalancers?.[0]) {
    manifest.loadBalancerArn = balancers.LoadBalancers[0].LoadBalancerArn;
    found.push(`Load balancer ${names.loadBalancerName} (billed hourly)`);
  }
  const groups = await soft(elbv2.send(new DescribeTargetGroupsCommand({ Names: [names.targetGroupName] })));
  if (groups?.TargetGroups?.[0]) {
    manifest.targetGroupArn = groups.TargetGroups[0].TargetGroupArn;
    found.push(`Target group ${names.targetGroupName}`);
  }
  const securityGroups = await soft(ec2.send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: "group-name", Values: [names.albSecurityGroupName, names.taskSecurityGroupName] }] })));
  for (const group of securityGroups?.SecurityGroups || []) {
    if (group.GroupName === names.albSecurityGroupName) manifest.albSecurityGroupId = group.GroupId;
    if (group.GroupName === names.taskSecurityGroupName) manifest.taskSecurityGroupId = group.GroupId;
    found.push(`Security group ${group.GroupName}`);
  }
  for (const [key, roleName] of [["executionRoleName", names.executionRoleName], ["taskRoleName", names.taskRoleName]]) {
    if (await soft(iam.send(new GetRoleCommand({ RoleName: roleName })))) {
      manifest[key] = roleName;
      found.push(`IAM role ${roleName}`);
    }
  }
  const logGroups = await soft(logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: names.logGroupName })));
  if (logGroups?.logGroups?.some((group) => group.logGroupName === names.logGroupName)) {
    manifest.logGroupName = names.logGroupName;
    found.push(`CloudWatch log group ${names.logGroupName}`);
  }
  const secretName = `skyforge/${names.appName}/env`;
  const secret = await soft(secrets.send(new DescribeSecretCommand({ SecretId: secretName })));
  if (secret && !secret.DeletedDate) {
    manifest.secretName = secretName;
    found.push(`Secrets Manager secret ${secretName} (billed monthly)`);
  }
  const waf = await findWafLeftovers({ credentials, appName: names.appName }).catch(() => ({}));
  if (waf.webAcl || waf.ipSet) {
    manifest.webAclId = waf.webAcl?.Id;
    manifest.webAclArn = waf.webAcl?.ARN;
    manifest.ipSetId = waf.ipSet?.Id;
    if (waf.webAcl) found.push(`WAF firewall ${waf.webAcl.Name} (billed monthly)`);
    if (waf.ipSet) found.push(`WAF ban list ${waf.ipSet.Name}`);
  }
  if (await canaryExists({ credentials, appName: names.appName }).catch(() => false)) {
    manifest.canaryUserName = `${names.appName}-canary`;
    found.push(`Canary IAM user ${names.appName}-canary`);
  }
  if (repositoryName) {
    const { createEcrClient } = await import("./ecrService.js");
    const { DescribeRepositoriesCommand } = await import("@aws-sdk/client-ecr");
    const repository = await createEcrClient(credentials).send(new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] })).catch(() => null);
    if (repository?.repositories?.length) {
      manifest.repositoryName = repositoryName;
      found.push(`ECR repository ${repositoryName} (image storage billed monthly)`);
    }
  }
  return { manifest, found };
}
