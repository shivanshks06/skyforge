import "dotenv/config";
import prisma from "../config/db.js";
import { encryptObjectValues, encryptSecret, isEncryptedSecret } from "../services/secretService.js";

let updated = 0;
try {
  const githubAccounts = await prisma.gitHubAccount.findMany({ select: { id: true, accessToken: true } });
  for (const account of githubAccounts) {
    if (!isEncryptedSecret(account.accessToken)) {
      await prisma.gitHubAccount.update({ where: { id: account.id }, data: { accessToken: encryptSecret(account.accessToken) } });
      updated += 1;
    }
  }

  const awsConnections = await prisma.awsConnection.findMany({ select: { id: true, accessKeyId: true, secretAccessKey: true, sessionToken: true } });
  for (const connection of awsConnections) {
    const data = {};
    if (connection.accessKeyId && !isEncryptedSecret(connection.accessKeyId)) data.accessKeyId = encryptSecret(connection.accessKeyId);
    if (connection.secretAccessKey && !isEncryptedSecret(connection.secretAccessKey)) data.secretAccessKey = encryptSecret(connection.secretAccessKey);
    if (connection.sessionToken && !isEncryptedSecret(connection.sessionToken)) data.sessionToken = encryptSecret(connection.sessionToken);
    if (Object.keys(data).length) {
      await prisma.awsConnection.update({ where: { id: connection.id }, data });
      updated += 1;
    }
  }

  const projects = await prisma.project.findMany({ select: { id: true, envConfig: true } });
  for (const project of projects) {
    if (!project.envConfig || typeof project.envConfig !== "object" || Array.isArray(project.envConfig)) continue;
    const entries = Object.values(project.envConfig);
    if (entries.some((value) => typeof value === "string" && !isEncryptedSecret(value))) {
      await prisma.project.update({ where: { id: project.id }, data: { envConfig: encryptObjectValues(project.envConfig) } });
      updated += 1;
    }
  }
  console.log(`Encrypted ${updated} legacy secret record(s).`);
} finally {
  await prisma.$disconnect();
}
