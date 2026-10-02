import {
  IAMClient,
  CreateAccessKeyCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DeleteUserCommand,
  GetAccessKeyLastUsedCommand,
  GetUserCommand,
  ListAccessKeysCommand,
} from "@aws-sdk/client-iam";

/**
 * Canary secrets: an IAM user with no permissions whose access key is planted in the container's
 * environment. Nothing legitimate ever uses it, so any recorded use means the container's
 * environment (or image) leaked. IAM users and keys are free.
 */

export const CANARY_ENV = { keyId: "AWS_BACKUP_ACCESS_KEY_ID", secret: "AWS_BACKUP_SECRET_ACCESS_KEY" };
const PATH = "/skyforge/";

function client(credentials) {
  return new IAMClient({
    region: credentials.region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
  });
}

export const canaryUserName = (appName) => `${appName}-canary`.slice(0, 64);
const isMissing = (error) => error?.name === "NoSuchEntityException" || error?.name === "NoSuchEntity";

/** Creates the canary user and a fresh key. Returns { userName, accessKeyId, secretAccessKey }. */
export async function createCanary({ credentials, appName }) {
  const iam = client(credentials);
  const userName = canaryUserName(appName);
  try {
    await iam.send(new GetUserCommand({ UserName: userName }));
  } catch (error) {
    if (!isMissing(error)) throw error;
    await iam.send(new CreateUserCommand({ UserName: userName, Path: PATH, Tags: [{ Key: "skyforge:managed", Value: "true" }, { Key: "skyforge:purpose", Value: "canary" }] }));
  }
  // Rotate: a user can hold at most two keys, and the old secret is not recoverable anyway.
  const existing = await iam.send(new ListAccessKeysCommand({ UserName: userName }));
  for (const key of existing.AccessKeyMetadata || []) {
    await iam.send(new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: key.AccessKeyId }));
  }
  const created = await iam.send(new CreateAccessKeyCommand({ UserName: userName }));
  return { userName, accessKeyId: created.AccessKey.AccessKeyId, secretAccessKey: created.AccessKey.SecretAccessKey };
}

/** { used, lastUsedAt, service, region } for the canary key. */
export async function checkCanary({ credentials, accessKeyId }) {
  const result = await client(credentials).send(new GetAccessKeyLastUsedCommand({ AccessKeyId: accessKeyId }));
  const lastUsed = result.AccessKeyLastUsed || {};
  return {
    used: Boolean(lastUsed.LastUsedDate),
    lastUsedAt: lastUsed.LastUsedDate ? new Date(lastUsed.LastUsedDate).toISOString() : null,
    service: lastUsed.ServiceName && lastUsed.ServiceName !== "N/A" ? lastUsed.ServiceName : null,
    region: lastUsed.Region && lastUsed.Region !== "N/A" ? lastUsed.Region : null,
  };
}

/** Deletes the canary user and its keys; missing users count as deleted. */
export async function deleteCanary({ credentials, appName, userName }) {
  const iam = client(credentials);
  const name = userName || canaryUserName(appName);
  try {
    const keys = await iam.send(new ListAccessKeysCommand({ UserName: name }));
    for (const key of keys.AccessKeyMetadata || []) {
      await iam.send(new DeleteAccessKeyCommand({ UserName: name, AccessKeyId: key.AccessKeyId }));
    }
    await iam.send(new DeleteUserCommand({ UserName: name }));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export async function canaryExists({ credentials, appName }) {
  try {
    await client(credentials).send(new GetUserCommand({ UserName: canaryUserName(appName) }));
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
