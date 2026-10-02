import "../config/env.js";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import prisma from "../config/db.js";
import { getAwsCredentials } from "../services/awsConnectionService.js";

// NOT_CONNECTED rows are placeholders created when a user opens Settings; only verify real connections.
const connections = await prisma.awsConnection.findMany({
  where: { status: "CONNECTED" },
  select: {
    userId: true,
    status: true,
    authType: true,
    accountId: true,
    region: true,
    accessKeyId: true,
    secretAccessKey: true,
    sessionToken: true,
    roleArn: true,
  },
});

const results = [];
for (const connection of connections) {
  try {
    const credentials = await getAwsCredentials(connection);
    if (!credentials?.accessKeyId) throw new Error("The connection has no usable credentials.");
    const identity = await new STSClient({ region: credentials.region, credentials }).send(new GetCallerIdentityCommand({}));
    results.push({
      userId: connection.userId,
      status: connection.status,
      authType: connection.authType,
      configuredAccount: connection.accountId,
      actualAccount: identity.Account,
      region: connection.region,
      verified: identity.Account === connection.accountId,
    });
  } catch (error) {
    results.push({
      userId: connection.userId,
      status: connection.status,
      authType: connection.authType,
      configuredAccount: connection.accountId,
      region: connection.region,
      verified: false,
      error: error.name || error.message,
    });
  }
}

console.log(JSON.stringify(results, null, 2));
await prisma.$disconnect();
if (results.some((result) => !result.verified)) process.exitCode = 1;
