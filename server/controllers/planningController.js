import prisma from "../config/db.js";
import { generateAiDeploymentPlan } from "../services/aiPlanner.js";
import { generateDockerfile, generateTerraform } from "../services/templateEngine.js";
import { requireOwnedProject } from "../services/ownershipService.js";
import { decryptObjectValues, encryptObjectValues, MASKED_SECRET, maskObjectValues } from "../services/secretService.js";
import { toPublicProject } from "../services/projectSerializer.js";
import { assertProjectHasNoActiveOperation } from "../services/operationGuard.js";
import { effectiveRequiredEnv, localhostWarnings, scanGitHubRepository } from "../services/envScanner.js";
import { decryptSecret as decryptToken } from "../services/secretService.js";

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
    // Variables the user marked "not needed" (false positives) stop blocking deployment.
    const knownNames = new Set([...(project.requiredEnv || []), ...((project.envAnalysis?.variables || []).map((variable) => variable.name))]);
    const ignoredEnv = Array.isArray(req.body?.ignoredEnv)
      ? [...new Set(req.body.ignoredEnv.map(String).filter((name) => knownNames.has(name)))].slice(0, 100)
      : project.envAnalysis?.ignored || [];
    const envAnalysis = { ...(project.envAnalysis || { variables: [], services: [] }), ignored: ignoredEnv };
    const requiredEnvList = effectiveRequiredEnv({ requiredEnv: project.requiredEnv, envAnalysis });
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
        envAnalysis,
        configVersion: { increment: 1 },
        status: nextStatus,
      },
    });

    const plan = updatedProject.deploymentPlan || {};
    return res.json({
      message: "Environment variables saved successfully",
      project: exposeProject(updatedProject),
      blueprints: buildBlueprints(updatedProject, plan),
      warnings: localhostWarnings(envValues).map((name) => `${name} points to localhost, which on AWS is the container itself. Use the real hosted or public address.`),
    });
  } catch (error) {
    console.error("Error updating environment variables:", error);
    const isInputError = error instanceof Error && /environment variable|maximum/i.test(error.message);
    return res.status(error.statusCode || (isInputError ? 400 : 500)).json({
      message: isInputError ? error.message : "Failed to update environment variables",
    });
  }
};

export const scanEnvironment = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    await assertProjectHasNoActiveOperation(project.id);
    const [owner, repo] = String(project.repoName || "").split("/");
    const account = await prisma.gitHubAccount.findUnique({ where: { userId: project.userId } });
    const token = account ? decryptToken(account.accessToken) : null;
    let result = null;
    try {
      result = await scanGitHubRepository({ owner, repo, ref: project.branch, token });
    } catch (error) {
      // The configured branch may be gone; deployments fall back to the default branch too.
      if (error.response?.status !== 404) throw error;
      result = await scanGitHubRepository({ owner, repo, ref: null, token });
    }
    if (!result) return res.status(413).json({ message: "The repository is too large to scan from GitHub; it will be scanned during deployment." });

    const ignored = (project.envAnalysis?.ignored || []).filter((name) => result.variables.some((variable) => variable.name === name));
    const updatedProject = await prisma.project.update({
      where: { id: project.id },
      data: {
        envAnalysis: { ...result, ignored },
        requiredEnv: result.variables.filter((variable) => variable.required).map((variable) => variable.name),
      },
    });
    return res.json({ project: exposeProject(updatedProject) });
  } catch (error) {
    console.error("Error scanning environment variables:", error.response?.status || error.message);
    return res.status(error.statusCode || 502).json({ message: "Could not scan the repository for environment variables." });
  }
};
