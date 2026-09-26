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
  ListTaskDefinitionsCommand,
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
  ModifyListenerCommand,
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
import { CloudWatchLogsClient, CreateLogGroupCommand, DeleteLogGroupCommand, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { SecretsManagerClient, CreateSecretCommand, DescribeSecretCommand, PutSecretValueCommand, DeleteSecretCommand } from "@aws-sdk/client-secrets-manager";
import { emitDeploymentLog } from "./logsService.js";
import { ensureHttpsEdge } from "./cloudfrontEdgeService.js";
import { decryptObjectValues } from "./secretService.js";
import { awsPartitionForRegion } from "./awsPartition.js";

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

function resourceNames(project) {
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

  const vpcs = await ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: "isDefault", Values: ["true"] }] }));
  const vpcId = configuredVpc || vpcs.Vpcs?.[0]?.VpcId;
  if (!vpcId) throw new Error("No VPC is configured or available. Set AWS_VPC_ID and AWS_SUBNET_IDS or create a default VPC.");
  const subnets = await ec2.send(new DescribeSubnetsCommand({
    Filters: [{ Name: "vpc-id", Values: [vpcId] }, { Name: "default-for-az", Values: ["true"] }],
  }));
  const selectedSubnets = [];
  for (const subnet of subnets.Subnets || []) {
    if (!subnet.SubnetId || !subnet.AvailabilityZone) continue;
    if (selectedSubnets.length && selectedSubnets[0].AvailabilityZone === subnet.AvailabilityZone) continue;
    selectedSubnets.push(subnet);
    if (selectedSubnets.length === 2) break;
  }
  if (selectedSubnets.length < 2) throw new Error("At least two usable subnets in different availability zones are required.");
  return { vpcId, subnetIds: selectedSubnets.map((subnet) => subnet.SubnetId) };
}

async function cloudFrontPrefixList(ec2) {
  try {
    for (const name of ["com.amazonaws.global.cloudfront.origin-facing", "CloudFrontOriginFacingSecurityGroup"]) {
      const result = await ec2.send(new DescribeManagedPrefixListsCommand({ Filters: [{ Name: "prefix-list-name", Values: [name] }] }));
      const id = result.PrefixLists?.[0]?.PrefixListId;
      if (id) return id;
    }
  } catch {}
  return null;
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
      Matcher: { HttpCode: "200-399" },
    }));
    targetGroup = created.TargetGroups?.[0];
  }
  if (!targetGroup?.TargetGroupArn) throw new Error("AWS did not return a usable target group.");
  if (targetGroup.Port !== port || targetGroup.HealthCheckPath !== normalizedHealthPath) {
    const modified = await elbv2.send(new ModifyTargetGroupCommand({
      TargetGroupArn: targetGroup.TargetGroupArn,
      Port: port,
      HealthCheckProtocol: "HTTP",
      HealthCheckPort: String(port),
      HealthCheckPath: normalizedHealthPath,
      Matcher: { HttpCode: "200-399" },
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

function taskDefinitionInput(project, imageUri, port, executionRoleArn, taskRoleArn, logGroupName, region, secret) {
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
      environment: [],
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

export async function deployToEcs({ deploymentId, project, credentials, imageUri, onResources }) {
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
  const albPrefixListId = await cloudFrontPrefixList(ec2);
  const albIngress = albPrefixListId
    ? { IpProtocol: "tcp", FromPort: 80, ToPort: 80, PrefixListIds: [{ PrefixListId: albPrefixListId }] }
    : { IpProtocol: "tcp", FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "Public HTTP Ingress" }] };

  if (albPrefixListId) {
    emitDeploymentLog(deploymentId, { stage: "PROVISIONING", message: `[ALB] Secured ALB ingress using CloudFront managed prefix list (${albPrefixListId}).`, level: "info" });
  } else {
    emitDeploymentLog(deploymentId, { stage: "PROVISIONING", message: `[ALB] CloudFront prefix list unavailable; configuring direct public HTTP ingress on port 80.`, level: "info" });
  }

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
      taskDefinition = await ecs.send(new RegisterTaskDefinitionCommand(taskDefinitionInput(project, imageUri, port, executionRoleArn, taskRoleArn, logGroupName, region, secret)));
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
          healthCheckGracePeriodSeconds: 60,
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

  await waitUntilServicesStable(
    { client: ecs, maxWaitTime: Number.parseInt(process.env.ECS_WAIT_SECONDS || "900", 10) },
    { cluster: names.clusterName, services: [names.serviceName] },
  );
  service = await describeService(ecs, names.clusterName, names.serviceName);
  if (!service || service.status !== "ACTIVE") throw new Error("ECS service did not reach ACTIVE state.");

  let endpoint = null;
  try {
    const edge = await ensureHttpsEdge({
      deploymentId,
      credentials,
      loadBalancerDns: loadBalancer.dnsName,
      onResources: async (partialResources) => {
        Object.assign(resources, partialResources);
        await checkpoint();
      },
    });
    resources.edgeDistributionId = edge.distributionId;
    resources.edgeDistributionArn = edge.distributionArn;
    resources.edgeOriginDomain = edge.originDomain;
    await checkpoint();
    endpoint = edge.domainName;
  } catch (edgeError) {
    emitDeploymentLog(deploymentId, {
      stage: "DEPLOYING",
      message: `[CLOUDFRONT] HTTPS edge notice: ${edgeError.message.slice(0, 160)}. Using direct ALB endpoint http://${loadBalancer.dnsName}...`,
      level: "warn",
    });
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId: albSecurityGroupId,
      IpPermissions: [{ IpProtocol: "tcp", FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: "0.0.0.0/0" }] }],
    })).catch(() => {});
    endpoint = `http://${loadBalancer.dnsName}`;
  }
  emitDeploymentLog(deploymentId, { stage: "DEPLOYING", message: `[ECS] Service ${names.serviceName} is stable with task definition ${taskDefinitionArn}.`, level: "success" });
  return {
    success: true,
    type: "ECS_FARGATE",
    endpoint,
    resources,
  };
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
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
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

  if (resources.taskSecurityGroupId) {
    for (let attempt = 1; attempt <= 15; attempt += 1) {
      try {
        await ignoreMissing(ec2.send(new DeleteSecurityGroupCommand({ GroupId: resources.taskSecurityGroupId })));
        break;
      } catch (err) {
        if (attempt < 15 && (err.name === "DependencyViolation" || /dependency|in use/i.test(err.message))) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        if (!isMissingResourceError(err)) throw err;
      }
    }
  }

  if (resources.albSecurityGroupId) {
    for (let attempt = 1; attempt <= 25; attempt += 1) {
      try {
        await ignoreMissing(ec2.send(new DeleteSecurityGroupCommand({ GroupId: resources.albSecurityGroupId })));
        break;
      } catch (err) {
        if (attempt < 25 && (err.name === "DependencyViolation" || /dependency|in use/i.test(err.message))) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        if (!isMissingResourceError(err)) throw err;
      }
    }
  }

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
    await verifyResourceAbsent(async () => {
      const s = await describeService(ecs, resources.clusterName, resources.serviceName);
      return Boolean(s && s.status !== "INACTIVE");
    }, `ECS service ${resources.serviceName}`);
  }
  if (resources.clusterName) {
    await verifyResourceAbsent(async () => {
      const result = await ecs.send(new DescribeClustersCommand({ clusters: [resources.clusterName] }));
      return Boolean(result.clusters?.some((cluster) => cluster.clusterArn));
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
