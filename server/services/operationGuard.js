import prisma from "../config/db.js";

export const ACTIVE_DEPLOYMENT_STATUSES = [
  "QUEUED",
  "BUILDING",
  "PUSHING",
  "PROVISIONING",
  "DEPLOYING",
  "HEALTH_CHECK",
  "ROLLING_BACK",
  "DESTROYING",
];

export async function assertProjectHasNoActiveOperation(projectId) {
  const active = await prisma.deployment.findFirst({
    where: { projectId, status: { in: ACTIVE_DEPLOYMENT_STATUSES } },
    select: { id: true, status: true },
  });
  if (!active) return;
  const error = new Error(`Wait for the active ${active.status.toLowerCase().replaceAll("_", " ")} operation to finish before changing project configuration.`);
  error.statusCode = 409;
  throw error;
}
