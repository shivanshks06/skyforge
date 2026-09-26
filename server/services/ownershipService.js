import prisma from "../config/db.js";

export async function getOwnedProject(projectId, userId) {
  if (!projectId || !userId) return null;
  return prisma.project.findFirst({ where: { id: projectId, userId } });
}

export async function getOwnedDeployment(deploymentId, userId) {
  if (!deploymentId || !userId) return null;
  return prisma.deployment.findFirst({
    where: { id: deploymentId, project: { userId } },
  });
}

export async function requireOwnedProject(projectId, userId) {
  const project = await getOwnedProject(projectId, userId);
  if (!project) {
    const error = new Error("Project not found");
    error.statusCode = 404;
    throw error;
  }
  return project;
}

export async function requireOwnedDeployment(deploymentId, userId) {
  const deployment = await getOwnedDeployment(deploymentId, userId);
  if (!deployment) {
    const error = new Error("Deployment not found");
    error.statusCode = 404;
    throw error;
  }
  return deployment;
}
