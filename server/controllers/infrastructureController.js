import prisma from "../config/db.js";
import {
  generateTerraformBlueprints,
  saveTerraformFilesToDisk,
} from "../services/terraformEngine.js";
import { requireOwnedProject } from "../services/ownershipService.js";
import { toPublicProject } from "../services/projectSerializer.js";
import { assertProjectHasNoActiveOperation } from "../services/operationGuard.js";

async function regionForProject(project) {
  const connection = await prisma.awsConnection.findUnique({
    where: { userId: project.userId },
    select: { region: true },
  });
  return connection?.region || process.env.AWS_REGION || "us-east-1";
}

function blueprintResponse(project, blueprints, saveResult) {
  return {
    project: toPublicProject(project),
    manifest: blueprints.manifest,
    target: blueprints.target,
    region: blueprints.region,
    displayName: blueprints.infraPlan.displayName,
    strategyDescription: blueprints.infraPlan.strategyDescription,
    services: blueprints.infraPlan.services,
    architectureGraph: blueprints.infraPlan.architectureGraph,
    costEstimation: blueprints.cost,
    files: blueprints.files,
    terraformPath: saveResult.terraformPath,
    manifestPath: saveResult.manifestPath,
  };
}

export const getInfrastructure = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    await assertProjectHasNoActiveOperation(project.id);
    const region = await regionForProject(project);
    const blueprints = generateTerraformBlueprints(project, project.deploymentPlan || {}, region);
    const saveResult = saveTerraformFilesToDisk(project.id, blueprints);

    const updatedProject = await prisma.project.update({
      where: { id: project.id },
      data: {
        infrastructureManifest: blueprints.manifest,
        terraformGenerated: true,
        terraformPath: saveResult.terraformPath,
        estimatedCost: blueprints.cost.total,
        deploymentTarget: blueprints.target,
        configVersion: { increment: 1 },
        status: ["Containerized", "Planned"].includes(project.status) ? "Configured" : project.status,
      },
    });

    return res.json(blueprintResponse(updatedProject, blueprints, saveResult));
  } catch (error) {
    console.error("Error fetching infrastructure blueprint:", error);
    return res.status(error.statusCode || 500).json({ message: "Failed to fetch cloud infrastructure blueprint" });
  }
};
