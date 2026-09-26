import prisma from "../config/db.js";
import { Prisma } from "@prisma/client";
import {
  generateExternalId,
  generateCloudFormationTemplate,
  getCloudFormationLaunchUrl,
  verifyAwsConnection,
  verifyAwsAccessKeys,
} from "../services/awsConnectionService.js";
import { encryptSecret, maskSecret } from "../services/secretService.js";

function validRegion(region) {
  const value = String(region || "ap-south-1");
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(value)) throw new Error("Invalid AWS region.");
  return value;
}

function publicConnection(connection) {
  if (!connection) return null;
  const hasAccessKeys = Boolean(connection.accessKeyId && connection.secretAccessKey);
  let cloudFormationLaunchUrl = null;
  try {
    cloudFormationLaunchUrl = connection.externalId
      ? getCloudFormationLaunchUrl(connection.region)
      : null;
  } catch {
    // SKYFORGE_AWS_ACCOUNT_ID not configured — CloudFormation setup unavailable
  }
  return {
    connected: connection.status === "CONNECTED",
    status: connection.status,
    authType: connection.authType,
    hasAccessKeys,
    maskedAccessKey: hasAccessKeys ? maskSecret(connection.accessKeyId) : null,
    roleArn: connection.roleArn || null,
    accountId: connection.accountId || null,
    region: connection.region,
    externalId: connection.externalId,
    cloudFormationLaunchUrl,
  };
}

async function findRecordedCloudResources(userId) {
  return prisma.deployment.findFirst({
    where: {
      project: { userId },
      OR: [
        { status: { in: ["QUEUED", "BUILDING", "PUSHING", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "ROLLING_BACK", "DESTROYING"] } },
        { resources: { not: Prisma.AnyNull }, status: { not: "DESTROYED" } },
      ],
    },
    select: { id: true, projectId: true, project: { select: { name: true } } },
  });
}

async function assertAccountSwitchAllowed(existingConnection, nextAccountId, nextRegion, userId) {
  const accountChanged = Boolean(existingConnection?.accountId) && existingConnection.accountId !== nextAccountId;
  const regionChanged = Boolean(existingConnection?.region) && existingConnection.region !== nextRegion;
  if (!accountChanged && !regionChanged) return;
  const deployment = await findRecordedCloudResources(userId);
  if (!deployment) return;
  const error = new Error(`Wait for active operations and destroy recorded cloud resources for project "${deployment.project.name}" before switching the AWS account or region.`);
  error.statusCode = 409;
  throw error;
}

export const getAwsStatus = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Authentication required" });

    let connection = await prisma.awsConnection.findUnique({ where: { userId } });
    if (!connection) {
      connection = await prisma.awsConnection.create({
        data: {
          userId,
          externalId: generateExternalId(),
          status: "NOT_CONNECTED",
        },
      });
    }

    return res.json(publicConnection(connection));
  } catch (error) {
    console.error("Error fetching AWS connection status:", error);
    return res.status(500).json({ message: "Failed to fetch AWS connection status" });
  }
};

export const initiateAwsSetup = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Authentication required" });
    const region = validRegion(req.body?.region);

    const existing = await prisma.awsConnection.findUnique({ where: { userId } });
    if (existing?.status === "CONNECTED" && existing.region !== region) {
      const error = new Error("Disconnect the current AWS account or finish teardown before changing its region.");
      error.statusCode = 409;
      throw error;
    }
    await assertAccountSwitchAllowed(existing, existing?.accountId || "", region, userId);
    const externalId = existing?.externalId || generateExternalId();

    const connection = await prisma.awsConnection.upsert({
      where: { userId },
      update: { region, externalId },
      create: { userId, externalId, region, status: "NOT_CONNECTED" },
    });

    const template = generateCloudFormationTemplate(connection.externalId, undefined, region);
    const launchUrl = getCloudFormationLaunchUrl(region);

    return res.json({
      externalId: connection.externalId,
      region,
      template,
      launchUrl,
      status: connection.status,
    });
  } catch (error) {
    console.error("Error initiating AWS setup:", error);
    return res.status(400).json({ message: error.message || "Failed to initiate AWS setup" });
  }
};

export const connectAwsRole = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Authentication required" });
    const roleArn = String(req.body?.roleArn || "").trim();
    const region = validRegion(req.body?.region);
    if (!roleArn) return res.status(400).json({ message: "Role ARN is required." });

    const existing = await prisma.awsConnection.findUnique({ where: { userId } });
    const externalId = existing?.externalId || generateExternalId();
    const verification = await verifyAwsConnection({ roleArn, externalId, region });
    await assertAccountSwitchAllowed(existing, verification.accountId, region, userId);

    const connection = await prisma.awsConnection.upsert({
      where: { userId },
      update: {
        roleArn: verification.roleArn,
        externalId,
        accountId: verification.accountId,
        region,
        authType: "ROLE_ARN",
        status: "CONNECTED",
        accessKeyId: null,
        secretAccessKey: null,
        sessionToken: null,
      },
      create: {
        userId,
        roleArn: verification.roleArn,
        externalId,
        accountId: verification.accountId,
        region,
        authType: "ROLE_ARN",
        status: "CONNECTED",
      },
    });

    return res.json({ message: "AWS account connected successfully", connection: publicConnection(connection) });
  } catch (error) {
    console.error("Error connecting AWS role:", error);
    return res.status(error.statusCode || 400).json({ message: error.message || "Failed to verify AWS connection" });
  }
};

export const disconnectAws = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Authentication required" });
    const recordedResources = await findRecordedCloudResources(userId);
    if (recordedResources) {
      return res.status(409).json({
        message: `Wait for active operations and destroy recorded cloud resources for project "${recordedResources.project.name}" before disconnecting AWS.`,
        deploymentId: recordedResources.id,
        projectId: recordedResources.projectId,
      });
    }
    await prisma.awsConnection.deleteMany({ where: { userId } });
    return res.json({ message: "AWS connection removed successfully", connected: false });
  } catch (error) {
    console.error("Error disconnecting AWS:", error);
    return res.status(error.statusCode || 500).json({ message: "Failed to disconnect AWS account" });
  }
};

export const saveAwsCredentials = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Authentication required" });

    const accessKeyId = String(req.body?.accessKeyId || "").trim();
    const secretAccessKey = String(req.body?.secretAccessKey || "").trim();
    const sessionToken = String(req.body?.sessionToken || "").trim();
    const region = validRegion(req.body?.region);
    if (!accessKeyId || !secretAccessKey) {
      return res.status(400).json({ message: "Access Key ID and Secret Access Key are required." });
    }

    const verified = await verifyAwsAccessKeys({ accessKeyId, secretAccessKey, sessionToken, region });
    const existing = await prisma.awsConnection.findUnique({ where: { userId } });
    await assertAccountSwitchAllowed(existing, verified.accountId, region, userId);
    const connection = await prisma.awsConnection.upsert({
      where: { userId },
      update: {
        accessKeyId: encryptSecret(accessKeyId),
        secretAccessKey: encryptSecret(secretAccessKey),
        sessionToken: sessionToken ? encryptSecret(sessionToken) : null,
        accountId: verified.accountId,
        region,
        authType: "ACCESS_KEYS",
        status: "CONNECTED",
        roleArn: null,
        externalId: null,
      },
      create: {
        userId,
        accessKeyId: encryptSecret(accessKeyId),
        secretAccessKey: encryptSecret(secretAccessKey),
        sessionToken: sessionToken ? encryptSecret(sessionToken) : null,
        accountId: verified.accountId,
        region,
        authType: "ACCESS_KEYS",
        status: "CONNECTED",
      },
    });

    return res.json({ message: "AWS credentials connected successfully", connection: publicConnection(connection) });
  } catch (error) {
    console.error("Error saving AWS credentials:", error);
    let userMessage = error.message || "Failed to verify AWS credentials";
    if (error.name === "InvalidClientTokenId" || /security token/i.test(error.message)) {
      userMessage = "AWS STS could not verify this Access Key ID. Please verify the Access Key ID is active in AWS IAM console (and wait 30 seconds if just created).";
    } else if (error.name === "SignatureDoesNotMatch" || /signature/i.test(error.message)) {
      userMessage = "The Secret Access Key is incorrect. Please ensure the full 40-character secret key was pasted without extra spaces.";
    }
    return res.status(error.statusCode || 400).json({ message: userMessage });
  }
};
