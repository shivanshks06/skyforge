import prisma from "../config/db.js";
import { generateTerraformBlueprints, saveTerraformFilesToDisk } from "../services/terraformEngine.js";
import { requireOwnedProject } from "../services/ownershipService.js";
import { toPublicProject } from "../services/projectSerializer.js";
import { assertProjectHasNoActiveOperation } from "../services/operationGuard.js";
import { TARGETS, TARGET_INFO, normalizeTarget, looksStatic } from "../services/targets.js";

async function regionForProject(project) {
  const connection = await prisma.awsConnection.findUnique({ where: { userId: project.userId }, select: { region: true } });
  return connection?.region || process.env.AWS_REGION || "us-east-1";
}

/** The three targets with whether they suit this project. Nothing is preselected. */
function choicesFor(project) {
  const staticLikely = looksStatic(project);
  return Object.entries(TARGET_INFO).map(([id, info]) => ({
    id,
    ...info,
    suitable: info.supports === "any" || staticLikely,
    note: info.supports === "static" && !staticLikely
      ? "This app appears to need a server, so S3 hosting would fail; pick an ECS option."
      : null,
  }));
}

function blueprintResponse(project, blueprints, saveResult) {
  return {
    project: toPublicProject(project),
    target: blueprints?.target || null,
    choices: choicesFor(project),
    ...(blueprints ? {
      manifest: blueprints.manifest,
      region: blueprints.region,
      displayName: blueprints.infraPlan.displayName,
      strategyDescription: blueprints.infraPlan.strategyDescription,
      services: blueprints.infraPlan.services,
      architectureGraph: blueprints.infraPlan.architectureGraph,
      costEstimation: blueprints.cost,
      files: blueprints.files,
      terraformPath: saveResult?.terraformPath,
      manifestPath: saveResult?.manifestPath,
    } : {}),
  };
}

export const getInfrastructure = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    const target = normalizeTarget(project.deploymentTarget);
    if (!target) return res.json(blueprintResponse(project, null, null));
    const blueprints = generateTerraformBlueprints(project, project.deploymentPlan || {}, {}, target, await regionForProject(project));
    return res.json(blueprintResponse(project, blueprints, saveTerraformFilesToDisk(project.id, blueprints)));
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
    if (!target) return res.status(400).json({ message: "Choose AWS_ECS_FARGATE, AWS_ECS_CLOUDFRONT, or AWS_S3_CLOUDFRONT." });
    if (target === TARGETS.S3_CLOUDFRONT && !looksStatic(project)) {
      return res.status(400).json({ message: "S3 + CloudFront hosts static sites only, and this app needs a server. Choose ECS Fargate or ECS Fargate + CloudFront." });
    }
    const live = await prisma.deployment.findFirst({
      where: { projectId: project.id, status: { in: ["LIVE", "ROLLED_BACK"] } },
      select: { id: true, target: true },
    });
    const currentFamily = /S3/.test(project.deploymentTarget || "") ? "S3" : "ECS";
    const nextFamily = target === TARGETS.S3_CLOUDFRONT ? "S3" : "ECS";
    if (live && currentFamily !== nextFamily) {
      return res.status(409).json({ message: "Destroy the current deployment before switching between ECS and S3 hosting; switching between the two ECS options applies on the next deploy." });
    }
    const blueprints = generateTerraformBlueprints(project, project.deploymentPlan || {}, {}, target, await regionForProject(project));
    const saveResult = saveTerraformFilesToDisk(project.id, blueprints);
    const updatedProject = await prisma.project.update({
      where: { id: project.id },
      data: {
        deploymentTarget: target,
        infrastructureManifest: blueprints.manifest,
        terraformGenerated: true,
        terraformPath: saveResult.terraformPath,
        estimatedCost: blueprints.cost.total,
        configVersion: { increment: 1 },
        status: ["Imported", "Planned", "Containerized"].includes(project.status) ? "Configured" : project.status,
      },
    });
    return res.json({ message: `Deployment target set to ${TARGET_INFO[target].label}.`, ...blueprintResponse(updatedProject, blueprints, saveResult) });
  } catch (error) {
    console.error("Error updating infrastructure target:", error);
    return res.status(error.statusCode || 500).json({ message: "Failed to update infrastructure target" });
  }
};
