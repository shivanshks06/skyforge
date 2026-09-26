import prisma from "../config/db.js";
import {
  generateTerraformBlueprints,
  saveTerraformFilesToDisk,
} from "../services/terraformEngine.js";
import { requireOwnedProject } from "../services/ownershipService.js";
import { AWS_TARGETS } from "../services/infrastructurePlanner.js";
import { toPublicProject } from "../services/projectSerializer.js";
import { assertProjectHasNoActiveOperation } from "../services/operationGuard.js";

async function regionForProject(project) {
  const connection = await prisma.awsConnection.findUnique({
    where: { userId: project.userId },
    select: { region: true },
  });
  return connection?.region || process.env.AWS_REGION || "us-east-1";
}

function canUseStaticOrigin(project) {
  const framework = String(project.framework || "").toLowerCase();
  const language = String(project.language || "").toLowerCase();
  return framework.includes("static")
    || framework.includes("html")
    || framework.includes("react")
    || framework.includes("vue")
    || framework.includes("angular")
    || (framework.includes("svelte") && !framework.includes("kit"))
    || language === "html / javascript";
}

function normalizeTarget(target) {
  const value = String(target || "").toUpperCase();
  if (value === "AWS S3 + CLOUDFRONT CDN" || value === "S3") return AWS_TARGETS.S3_CLOUDFRONT;
  if (value === "AWS ECS FARGATE" || value === "ECS") return AWS_TARGETS.ECS_FARGATE;
  if (new Set(Object.values(AWS_TARGETS)).has(value)) return value;
  throw new Error("Unsupported infrastructure target.");
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
    const blueprints = generateTerraformBlueprints(project, project.deploymentPlan || {}, {}, null, region);
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

export const updateInfrastructureTarget = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    await assertProjectHasNoActiveOperation(project.id);
    const target = normalizeTarget(req.body?.target);
    if (target === AWS_TARGETS.S3_CLOUDFRONT && !canUseStaticOrigin(project)) {
      return res.status(400).json({ message: "S3 + CloudFront is only available for static frontend projects." });
    }
    const region = await regionForProject(project);
    const blueprints = generateTerraformBlueprints(project, project.deploymentPlan || {}, {}, target, region);
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
        status: project.status === "Imported" ? "Planned" : project.status,
      },
    });

    return res.json({
      message: `Target switched to ${blueprints.infraPlan.displayName}`,
      ...blueprintResponse(updatedProject, blueprints, saveResult),
    });
  } catch (error) {
    console.error("Error updating infrastructure target:", error);
    const isInputError = error instanceof Error && error.message.includes("Unsupported");
    const status = error.statusCode || (isInputError ? 400 : 500);
    return res.status(status).json({ message: isInputError ? error.message : "Failed to update infrastructure target" });
  }
};
