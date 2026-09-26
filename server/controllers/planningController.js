import prisma from "../config/db.js";
import { generateAiDeploymentPlan } from "../services/aiPlanner.js";
import { generateDockerfile, generateTerraform } from "../services/templateEngine.js";
import { requireOwnedProject } from "../services/ownershipService.js";
import { decryptObjectValues, encryptObjectValues, MASKED_SECRET, maskObjectValues } from "../services/secretService.js";
import { toPublicProject } from "../services/projectSerializer.js";
import { assertProjectHasNoActiveOperation } from "../services/operationGuard.js";

function validateEnvValues(envValues) {
  if (!envValues || typeof envValues !== "object" || Array.isArray(envValues)) {
    throw new Error("envValues must be an object.");
  }
  const entries = Object.entries(envValues);
  if (entries.length > 100) throw new Error("A maximum of 100 environment variables is supported.");
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    if (value !== null && value !== undefined && typeof value === "object") {
      throw new Error(`Environment variable ${key} must be a scalar value.`);
    }
    if (String(value ?? "").length > 20_000) {
      throw new Error(`Environment variable ${key} is too large.`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(envValues), "utf8") > 60 * 1024) {
    throw new Error("Environment variables exceed the 60 KiB Secrets Manager limit.");
  }
  return envValues;
}

function exposeProject(project) {
  const configured = decryptObjectValues(project.envConfig || {});
  return {
    ...toPublicProject(project),
    envConfig: maskObjectValues(configured),
    envConfigStatus: Object.fromEntries(Object.entries(configured).map(([key, value]) => [key, Boolean(value)])),
  };
}

function buildBlueprints(project, plan) {
  return {
    dockerfile: generateDockerfile(project, plan || {}),
    // Never write user secrets into downloadable Terraform source. Runtime
    // deployment reads encrypted values from the database instead.
    terraform: generateTerraform(project, plan || {}, {}),
  };
}

async function createPlan(project) {
  return generateAiDeploymentPlan({
    framework: project.framework,
    language: project.language,
    packageManager: project.packageManager,
    buildCommand: project.buildCommand,
    startCommand: project.startCommand,
    port: project.port,
    dockerized: project.dockerized,
    requiredEnv: project.requiredEnv,
  });
}

export const generatePlan = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    await assertProjectHasNoActiveOperation(project.id);
    const plan = await createPlan(project);

    const updatedProject = await prisma.project.update({
      where: { id: project.id },
      data: {
        cpu: plan.cpu,
        memory: plan.memory,
        healthCheck: plan.healthCheck,
        deploymentTarget: plan.deploymentTarget,
        deploymentPlan: plan,
        configVersion: { increment: 1 },
        status: project.status === "Imported" ? "Planned" : project.status,
      },
    });

    return res.json({
      project: exposeProject(updatedProject),
      plan,
      blueprints: buildBlueprints(updatedProject, plan),
    });
  } catch (error) {
    console.error("Error generating AI deployment plan:", error);
    return res.status(error.statusCode || 500).json({ message: "Failed to generate deployment plan" });
  }
};

export const getPlan = async (req, res) => {
  try {
    let project = await requireOwnedProject(req.params.id, req.user?.id);
    let plan = project.deploymentPlan;
    if (!plan) await assertProjectHasNoActiveOperation(project.id);

    if (!plan) {
      plan = await createPlan(project);
      project = await prisma.project.update({
        where: { id: project.id },
        data: {
          cpu: plan.cpu,
          memory: plan.memory,
          healthCheck: plan.healthCheck,
          deploymentTarget: plan.deploymentTarget,
          deploymentPlan: plan,
          configVersion: { increment: 1 },
          status: project.status === "Imported" ? "Planned" : project.status,
        },
      });
    }

    return res.json({
      project: exposeProject(project),
      plan,
      blueprints: buildBlueprints(project, plan),
    });
  } catch (error) {
    console.error("Error fetching deployment plan:", error);
    return res.status(error.statusCode || 500).json({ message: "Failed to fetch deployment plan" });
  }
};

export const updateEnvVars = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    await assertProjectHasNoActiveOperation(project.id);
    const submittedValues = validateEnvValues(req.body?.envValues || {});
    const existingValues = decryptObjectValues(project.envConfig || {});
    const envValues = { ...existingValues };
    for (const [key, value] of Object.entries(submittedValues)) {
      if (value !== MASKED_SECRET) envValues[key] = value;
    }
    const requiredEnvList = Array.isArray(project.requiredEnv) ? project.requiredEnv : [];
    const allFilled = requiredEnvList.every(
      (key) => envValues[key] !== undefined && envValues[key] !== null && String(envValues[key]).trim() !== "",
    );

    const nextStatus = allFilled
      ? "Ready to Deploy"
      : (["Imported", "Planned"].includes(project.status) ? "Configured" : project.status);

    const updatedProject = await prisma.project.update({
      where: { id: project.id },
      data: {
        envConfig: encryptObjectValues(envValues),
        configVersion: { increment: 1 },
        status: nextStatus,
      },
    });

    const plan = updatedProject.deploymentPlan || {};
    return res.json({
      message: "Environment variables saved successfully",
      project: exposeProject(updatedProject),
      blueprints: buildBlueprints(updatedProject, plan),
    });
  } catch (error) {
    console.error("Error updating environment variables:", error);
    const isInputError = error instanceof Error && /environment variable|maximum/i.test(error.message);
    return res.status(error.statusCode || (isInputError ? 400 : 500)).json({
      message: isInputError ? error.message : "Failed to update environment variables",
    });
  }
};
