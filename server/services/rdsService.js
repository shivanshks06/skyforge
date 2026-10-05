import crypto from "node:crypto";
import {
  RDSClient,
  CreateDBInstanceCommand,
  CreateDBParameterGroupCommand,
  CreateDBSubnetGroupCommand,
  DeleteDBInstanceCommand,
  DeleteDBParameterGroupCommand,
  DeleteDBSubnetGroupCommand,
  DescribeDBInstancesCommand,
  DescribeDBParameterGroupsCommand,
  DescribeDBSubnetGroupsCommand,
  ModifyDBParameterGroupCommand,
} from "@aws-sdk/client-rds";
import {
  EC2Client,
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  RevokeSecurityGroupIngressCommand,
} from "@aws-sdk/client-ec2";
import prisma from "../config/db.js";
import { encryptSecret, decryptSecret } from "./secretService.js";
import { emitDeploymentLog } from "./logsService.js";

/**
 * SkyForge-managed database: a small RDS instance (PostgreSQL or MySQL) in the same VPC as the
 * app. It is private (no public address), only the app's containers may connect, the password is
 * generated and stored encrypted, and DATABASE_URL (plus common variants) is given to the app.
 * One-Click Destroy deletes it (no final snapshot, so nothing keeps billing).
 *
 * Cost: db.t4g.micro + 20 GB gp3 ≈ $13-16/month (free for 12 months on free-tier accounts).
 */

export const DB_ENGINES = {
  postgres: { engine: "postgres", version: "16", family: "postgres16", port: 5432, scheme: "postgresql", label: "PostgreSQL 16" },
  mysql: { engine: "mysql", version: "8.0", family: "mysql8.0", port: 3306, scheme: "mysql", label: "MySQL 8.0" },
};
export const DB_INSTANCE_CLASS = "db.t4g.micro";
export const DB_MONTHLY_ESTIMATE = "about $13-16/month (db.t4g.micro + 20 GB), free for 12 months on AWS free-tier accounts";
const USERNAME = "skyforge";

const config = (credentials) => ({
  region: credentials.region,
  credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}) },
});

/** RDS names must start with a letter and use letters, digits and single hyphens. */
export function databaseNames(appName) {
  const base = `${/^[a-z]/.test(appName) ? "" : "sf-"}${appName}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/-$/, "").slice(0, 55);
  return {
    identifier: `${base}-db`,
    subnetGroup: `${base}-db-subnets`,
    parameterGroup: `${base}-db-params`,
    securityGroup: `${base}-db-sg`,
    dbName: (base.replace(/[^a-z0-9]/g, "_").replace(/^[^a-z]+/, "") || "app").slice(0, 40),
  };
}

const isMissing = (error) => /NotFound|NotFoundFault|InvalidGroup\.NotFound|DBInstanceNotFound|DBSubnetGroupNotFound|DBParameterGroupNotFound/.test(`${error?.name} ${error?.Code || ""}`);
const tags = (appName) => [{ Key: "skyforge:managed", Value: "true" }, { Key: "skyforge:app", Value: appName }];

/** Environment variables that point the app at the database (common names for the major frameworks). */
export function databaseEnvironment({ engine, endpoint, port, dbName, password }) {
  const spec = DB_ENGINES[engine] || DB_ENGINES.postgres;
  const url = `${spec.scheme}://${USERNAME}:${encodeURIComponent(password)}@${endpoint}:${port}/${dbName}`;
  const common = { DATABASE_URL: url, DB_HOST: endpoint, DB_PORT: String(port), DB_USER: USERNAME, DB_USERNAME: USERNAME, DB_PASSWORD: password, DB_NAME: dbName, DB_DATABASE: dbName };
  return engine === "mysql"
    ? { ...common, MYSQL_URL: url, MYSQL_HOST: endpoint, MYSQL_PORT: String(port), MYSQL_USER: USERNAME, MYSQL_PASSWORD: password, MYSQL_DATABASE: dbName }
    : { ...common, POSTGRES_URL: url, PGHOST: endpoint, PGPORT: String(port), PGUSER: USERNAME, PGPASSWORD: password, PGDATABASE: dbName, POSTGRES_HOST: endpoint, POSTGRES_USER: USERNAME, POSTGRES_PASSWORD: password, POSTGRES_DB: dbName };
}

/** Names of variables SkyForge supplies when the managed database is on (so they are not "missing"). */
export function managedDatabaseKeys(engine = "postgres") {
  return Object.keys(databaseEnvironment({ engine, endpoint: "x", port: 1, dbName: "x", password: "x" }));
}

async function saveConfig(projectId, patch) {
  const current = await prisma.project.findUnique({ where: { id: projectId }, select: { databaseConfig: true } });
  const next = { ...(current?.databaseConfig || {}), ...patch };
  await prisma.project.update({ where: { id: projectId }, data: { databaseConfig: next } });
  return next;
}

async function ensureSecurityGroup(ec2, { name, network, port, appName }) {
  const found = await ec2.send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: "group-name", Values: [name] }, { Name: "vpc-id", Values: [network.vpcId] }] }));
  let groupId = found.SecurityGroups?.[0]?.GroupId;
  if (!groupId) {
    groupId = (await ec2.send(new CreateSecurityGroupCommand({
      GroupName: name, Description: `SkyForge database for ${appName}`, VpcId: network.vpcId,
      TagSpecifications: [{ ResourceType: "security-group", Tags: tags(appName) }],
    }))).GroupId;
    // Until the app's own security group exists, allow the private VPC range only; tightened after deploy.
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId: groupId, IpPermissions: [{ IpProtocol: "tcp", FromPort: port, ToPort: port, IpRanges: [{ CidrIp: network.cidr, Description: "VPC (temporary)" }] }] })).catch((error) => {
      if (error.name !== "InvalidPermission.Duplicate") throw error;
    });
  }
  return groupId;
}

/**
 * Creates (once) or finds the project's database and waits until it accepts connections.
 * Returns { engine, endpoint, port, dbName, username, password, identifier, securityGroupId }.
 */
export async function ensureManagedDatabase({ credentials, project, appName, network, deploymentId }) {
  const log = (message, level = "info") => emitDeploymentLog(deploymentId, { stage: "PROVISIONING", message, level });
  const settings = project.databaseConfig || {};
  const engine = DB_ENGINES[settings.engine] ? settings.engine : "postgres";
  const spec = DB_ENGINES[engine];
  const names = databaseNames(appName);
  const rds = new RDSClient(config(credentials));
  const ec2 = new EC2Client(config(credentials));

  const securityGroupId = await ensureSecurityGroup(ec2, { name: names.securityGroup, network, port: spec.port, appName });
  await rds.send(new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: names.subnetGroup })).catch(async (error) => {
    if (!isMissing(error)) throw error;
    await rds.send(new CreateDBSubnetGroupCommand({ DBSubnetGroupName: names.subnetGroup, DBSubnetGroupDescription: `SkyForge ${appName}`, SubnetIds: network.subnetIds, Tags: tags(appName) }));
  });
  if (engine === "postgres") {
    // RDS PostgreSQL 15+ forces TLS, which many app drivers cannot verify against the RDS CA out of
    // the box. The database is private to the VPC, so plain connections from the app are allowed.
    await rds.send(new DescribeDBParameterGroupsCommand({ DBParameterGroupName: names.parameterGroup })).catch(async (error) => {
      if (!isMissing(error)) throw error;
      await rds.send(new CreateDBParameterGroupCommand({ DBParameterGroupName: names.parameterGroup, DBParameterGroupFamily: spec.family, Description: `SkyForge ${appName}`, Tags: tags(appName) }));
      await rds.send(new ModifyDBParameterGroupCommand({ DBParameterGroupName: names.parameterGroup, Parameters: [{ ParameterName: "rds.force_ssl", ParameterValue: "0", ApplyMethod: "immediate" }] }));
    });
  }

  let password = settings.password ? decryptSecret(settings.password) : null;
  let instance = (await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: names.identifier })).catch((error) => {
    if (isMissing(error)) return null;
    throw error;
  }))?.DBInstances?.[0];
  if (instance && !password) {
    throw new Error(`Database ${names.identifier} exists but SkyForge has no password for it. Delete it in the RDS console (or destroy the project) and deploy again.`);
  }
  if (!instance) {
    password ||= crypto.randomBytes(24).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 28) + "Aa1";
    await saveConfig(project.id, { engine, password: encryptSecret(password), identifier: names.identifier, status: "creating", createdAt: new Date().toISOString() });
    log(`[DATABASE] Creating ${spec.label} (${DB_INSTANCE_CLASS}, 20 GB, private, encrypted) as ${names.identifier}. The first time takes about 5-10 minutes.`);
    instance = (await rds.send(new CreateDBInstanceCommand({
      DBInstanceIdentifier: names.identifier,
      Engine: spec.engine,
      EngineVersion: spec.version,
      DBInstanceClass: DB_INSTANCE_CLASS,
      AllocatedStorage: 20,
      StorageType: "gp3",
      StorageEncrypted: true,
      MasterUsername: USERNAME,
      MasterUserPassword: password,
      DBName: names.dbName,
      DBSubnetGroupName: names.subnetGroup,
      VpcSecurityGroupIds: [securityGroupId],
      ...(engine === "postgres" ? { DBParameterGroupName: names.parameterGroup } : {}),
      PubliclyAccessible: false,
      MultiAZ: false,
      BackupRetentionPeriod: 1,
      DeletionProtection: false,
      AutoMinorVersionUpgrade: true,
      CopyTagsToSnapshot: true,
      Tags: tags(appName),
    }))).DBInstance;
  }

  const deadline = Date.now() + 30 * 60_000;
  let lastStatus = null;
  while (instance?.DBInstanceStatus !== "available") {
    if (Date.now() > deadline) throw new Error(`Database ${names.identifier} did not become available within 30 minutes (status: ${instance?.DBInstanceStatus}).`);
    if (["failed", "incompatible-parameters", "incompatible-network", "storage-full", "inaccessible-encryption-credentials"].includes(instance?.DBInstanceStatus)) {
      throw new Error(`Database ${names.identifier} is in state "${instance.DBInstanceStatus}". Check it in the RDS console.`);
    }
    if (instance?.DBInstanceStatus === "stopped") throw new Error(`Database ${names.identifier} is stopped. Start it in the RDS console, then deploy again.`);
    if (instance?.DBInstanceStatus !== lastStatus) log(`[DATABASE] ${names.identifier}: ${instance?.DBInstanceStatus || "pending"}...`);
    lastStatus = instance?.DBInstanceStatus;
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    instance = (await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: names.identifier }))).DBInstances?.[0];
  }
  const result = {
    engine,
    endpoint: instance.Endpoint.Address,
    port: instance.Endpoint.Port,
    dbName: instance.DBName || names.dbName,
    username: USERNAME,
    password,
    identifier: names.identifier,
    securityGroupId,
  };
  await saveConfig(project.id, { engine, status: "available", identifier: names.identifier, endpoint: result.endpoint, port: result.port, dbName: result.dbName, username: USERNAME, securityGroupId, subnetGroup: names.subnetGroup, parameterGroup: engine === "postgres" ? names.parameterGroup : null });
  log(`[DATABASE] ${spec.label} is ready at ${result.endpoint}:${result.port} (database "${result.dbName}"). DATABASE_URL is set for the app.`, "success");
  return result;
}

/** After the app's security group exists: only the app's containers may reach the database. */
export async function restrictDatabaseToApp({ credentials, securityGroupId, taskSecurityGroupId, port }) {
  const ec2 = new EC2Client(config(credentials));
  const group = (await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [securityGroupId] }))).SecurityGroups?.[0];
  const allowsApp = group?.IpPermissions?.some((rule) => rule.UserIdGroupPairs?.some((pair) => pair.GroupId === taskSecurityGroupId));
  if (!allowsApp) {
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId: securityGroupId, IpPermissions: [{ IpProtocol: "tcp", FromPort: port, ToPort: port, UserIdGroupPairs: [{ GroupId: taskSecurityGroupId, Description: "SkyForge app containers" }] }] })).catch((error) => {
      if (error.name !== "InvalidPermission.Duplicate") throw error;
    });
  }
  const wide = (group?.IpPermissions || []).filter((rule) => rule.IpRanges?.length);
  if (wide.length) {
    await ec2.send(new RevokeSecurityGroupIngressCommand({ GroupId: securityGroupId, IpPermissions: wide.map((rule) => ({ IpProtocol: rule.IpProtocol, FromPort: rule.FromPort, ToPort: rule.ToPort, IpRanges: rule.IpRanges.map(({ CidrIp }) => ({ CidrIp })) })) })).catch(() => {});
  }
}

/** Database resources named for the app that still exist (teardown verification). */
export async function discoverManagedDatabase({ credentials, appName }) {
  const names = databaseNames(appName);
  const rds = new RDSClient(config(credentials));
  const ec2 = new EC2Client(config(credentials));
  const soft = (promise) => promise.catch((error) => (isMissing(error) ? null : Promise.reject(error)));
  const manifest = {};
  const found = [];
  const instance = (await soft(rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: names.identifier }))))?.DBInstances?.[0];
  if (instance && instance.DBInstanceStatus !== "deleted") {
    manifest.dbInstanceIdentifier = names.identifier;
    found.push(`RDS database ${names.identifier} (${instance.DBInstanceStatus}, billed hourly)`);
  }
  if (await soft(rds.send(new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: names.subnetGroup })))) {
    manifest.dbSubnetGroupName = names.subnetGroup;
    found.push(`RDS subnet group ${names.subnetGroup}`);
  }
  if (await soft(rds.send(new DescribeDBParameterGroupsCommand({ DBParameterGroupName: names.parameterGroup })))) {
    manifest.dbParameterGroupName = names.parameterGroup;
    found.push(`RDS parameter group ${names.parameterGroup}`);
  }
  const group = (await soft(ec2.send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: "group-name", Values: [names.securityGroup] }] }))))?.SecurityGroups?.[0];
  if (group) {
    manifest.dbSecurityGroupId = group.GroupId;
    found.push(`Database security group ${names.securityGroup}`);
  }
  return { manifest, found };
}

/**
 * Deletes the database (no final snapshot: nothing keeps billing), then its subnet group,
 * parameter group and security group. Waits until AWS confirms the instance is gone.
 */
export async function destroyManagedDatabase({ credentials, appName, deploymentId }) {
  const log = (message, level = "info") => emitDeploymentLog(deploymentId, { stage: "DESTROY", message, level });
  const names = databaseNames(appName);
  const rds = new RDSClient(config(credentials));
  const ec2 = new EC2Client(config(credentials));
  const describe = () => rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: names.identifier })).then((result) => result.DBInstances?.[0], (error) => {
    if (isMissing(error)) return null;
    throw error;
  });
  let instance = await describe();
  if (instance) {
    if (instance.DBInstanceStatus !== "deleting") {
      // A database that is still being created cannot be deleted yet; wait for it.
      const ready = Date.now() + 30 * 60_000;
      while (instance && !["available", "stopped", "failed", "storage-full", "incompatible-parameters", "incompatible-network", "deleting"].includes(instance.DBInstanceStatus) && Date.now() < ready) {
        log(`[DATABASE] Waiting for ${names.identifier} (${instance.DBInstanceStatus}) before deleting it...`);
        await new Promise((resolve) => setTimeout(resolve, 20_000));
        instance = await describe();
      }
      if (instance && instance.DBInstanceStatus !== "deleting") {
        await rds.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: names.identifier, SkipFinalSnapshot: true, DeleteAutomatedBackups: true })).catch((error) => {
          if (!isMissing(error) && !/InvalidDBInstanceState.*deleting|already being deleted/i.test(`${error.name} ${error.message}`)) throw error;
        });
      }
    }
    log(`[DATABASE] Deleting ${names.identifier} (no final snapshot). This takes about 5-10 minutes...`);
    const deadline = Date.now() + 30 * 60_000;
    while ((instance = await describe())) {
      if (Date.now() > deadline) throw new Error(`Database ${names.identifier} is still ${instance.DBInstanceStatus} after 30 minutes.`);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
    }
    log(`[DATABASE] ${names.identifier} deleted.`, "success");
  }
  await rds.send(new DeleteDBSubnetGroupCommand({ DBSubnetGroupName: names.subnetGroup })).catch((error) => {
    if (!isMissing(error)) throw error;
  });
  await rds.send(new DeleteDBParameterGroupCommand({ DBParameterGroupName: names.parameterGroup })).catch((error) => {
    if (!isMissing(error)) throw error;
  });
  const group = (await ec2.send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: "group-name", Values: [names.securityGroup] }] })).catch(() => null))?.SecurityGroups?.[0];
  if (group) {
    // The database's network interfaces are released a little after deletion.
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      try {
        await ec2.send(new DeleteSecurityGroupCommand({ GroupId: group.GroupId }));
        break;
      } catch (error) {
        if (isMissing(error)) break;
        if (error.name !== "DependencyViolation" || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }
  }
}

/** True when SkyForge creates and wires the database for this project. */
export const usesManagedDatabase = (project) => project?.databaseConfig?.mode === "rds";

/** databaseConfig safe for the browser (the password never leaves the server). */
export function publicDatabaseConfig(value) {
  if (!value) return { mode: "external" };
  const { password, ...rest } = value;
  return { ...rest, hasPassword: Boolean(password) };
}
