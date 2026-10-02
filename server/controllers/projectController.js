import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prisma from "../config/db.js";
import { Prisma } from "@prisma/client";
import { getOwnedProject } from "../services/ownershipService.js";
import { maskObjectValues } from "../services/secretService.js";
import { toPublicProject } from "../services/projectSerializer.js";
import { sanitizeEnvAnalysis } from "../services/envScanner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATED_DIR = path.resolve(__dirname, "../generated");

// All public project fields except envConfig (which contains encrypted secrets)
const publicProjectFields = {
  id: true,
  name: true,
  repoName: true,
  branch: true,
  framework: true,
  language: true,
  packageManager: true,
  buildTool: true,
  buildCommand: true,
  startCommand: true,
  port: true,
  dockerized: true,
  requiredEnv: true,
  envAnalysis: true,
  deploymentTarget: true,
  confidence: true,
  status: true,
  githubUrl: true,
  userId: true,
  cpu: true,
  memory: true,
  healthCheck: true,
  deploymentPlan: true,
  dockerStrategy: true,
  dockerGenerated: true,
  dockerPath: true,
  dockerValidation: true,
  infrastructureManifest: true,
  terraformGenerated: true,
  terraformPath: true,
  estimatedCost: true,
  createdAt: true,
  updatedAt: true,
  // envConfig intentionally excluded - use getProjectById to access env vars
};

function normalizeRepository(repoName, githubUrl) {
  const candidate = String(githubUrl || repoName || "").trim();
  if (!candidate) throw new Error("A GitHub repository is required.");

  let normalized = candidate
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error("Repository must be a valid GitHub owner/repository value.");
  }

  const [owner, repo] = normalized.split("/");
  if (!owner || !repo || owner === "." || owner === ".." || repo === "." || repo === "..") {
    throw new Error("Repository must be a valid GitHub owner/repository value.");
  }

  return { repoName: `${owner}/${repo}`, githubUrl: `https://github.com/${owner}/${repo}` };
}

function normalizeDeploymentTarget(value) {
  const normalized = String(value || "AWS ECS Fargate").trim().toLowerCase();
  if (["aws ecs fargate", "aws_ecs_fargate", "ecs fargate", "ecs_fargate", "fargate", "ecs"].includes(normalized)) {
    return "AWS ECS Fargate";
  }
  return "AWS ECS Fargate";
}

function parsePort(value) {
  if (value === null || value === undefined || value === "") return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be an integer between 1 and 65535.");
  }
  return port;
}

function parseConfidence(value) {
  if (value === null || value === undefined || value === "") return null;
  const confidence = Number(value);
  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) {
    throw new Error("Confidence must be an integer between 0 and 100.");
  }
  return confidence;
}

function normalizeRequiredEnv(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("requiredEnv must be an array.");

  const names = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  if (names.length > 100 || names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new Error("Environment variable names must be valid and limited to 100 entries.");
  }
  return names;
}

function normalizeMetadata(value, label, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLength || /[\0\r\n]/.test(text)) {
    throw new Error(`${label} must be a single-line value of at most ${maxLength} characters.`);
  }
  return text;
}

export const createProject = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Authentication required." });

    const {
      name,
      repoName,
      branch = "main",
      language,
      framework,
      packageManager,
      buildTool,
      buildCommand,
      startCommand,
      port,
      dockerized = false,
      requiredEnv = [],
      envAnalysis,
      deploymentTarget = "AWS ECS Fargate",
      confidence,
      githubUrl,
    } = req.body || {};

    const projectName = String(name || "").trim();
    if (!projectName || projectName.length > 120) {
      return res.status(400).json({ message: "Project name is required and must be at most 120 characters." });
    }

    if (repoName && githubUrl) {
      const repositoryFromName = normalizeRepository(repoName);
      const repositoryFromUrl = normalizeRepository(githubUrl);
      if (repositoryFromName.repoName !== repositoryFromUrl.repoName) {
        return res.status(400).json({ message: "repoName and githubUrl must identify the same repository." });
      }
    }
    if (dockerized !== undefined && typeof dockerized !== "boolean") {
      return res.status(400).json({ message: "dockerized must be a boolean." });
    }
    const repository = normalizeRepository(repoName, githubUrl);
    const normalizedBranch = String(branch || "main").trim();
    if (normalizedBranch.length > 255 || !/^[A-Za-z0-9._/-]+$/.test(normalizedBranch) || normalizedBranch.includes("..")) {
      return res.status(400).json({ message: "Branch name is invalid." });
    }

    const languageValue = normalizeMetadata(language, "Language", 80);
    const frameworkValue = normalizeMetadata(framework, "Framework", 120);
    const packageManagerValue = normalizeMetadata(packageManager, "Package manager", 40);
    const buildToolValue = normalizeMetadata(buildTool, "Build tool", 80);
    const buildCommandValue = normalizeMetadata(buildCommand, "Build command", 500);
    const startCommandValue = normalizeMetadata(startCommand, "Start command", 500);
    const deploymentTargetValue = normalizeDeploymentTarget(normalizeMetadata(deploymentTarget, "Deployment target", 120));

    const project = await prisma.project.create({
      data: {
        name: projectName,
        repoName: repository.repoName,
        branch: normalizedBranch,
        language: languageValue,
        framework: frameworkValue,
        packageManager: packageManagerValue,
        buildTool: buildToolValue,
        buildCommand: buildCommandValue,
        startCommand: startCommandValue,
        port: parsePort(port),
        dockerized: dockerized === true,
        requiredEnv: normalizeRequiredEnv(requiredEnv),
        ...(sanitizeEnvAnalysis(envAnalysis) ? { envAnalysis: sanitizeEnvAnalysis(envAnalysis) } : {}),
        deploymentTarget: deploymentTargetValue,
        confidence: parseConfidence(confidence),
        githubUrl: repository.githubUrl,
        status: "Imported",
        userId,
      },
    });

    return res.status(201).json(toPublicProject(project));
  } catch (error) {
    console.error("Error creating project:", error);
    const isInputError = error instanceof Error && /required|valid|must|Port|Branch|Confidence/i.test(error.message);
    return res.status(isInputError ? 400 : 500).json({
      message: isInputError ? error.message : "Failed to create project",
    });
  }
};

export const getProjects = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Authentication required." });

    const projects = await prisma.project.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: publicProjectFields,
    });

    return res.json(projects.map(toPublicProject));
  } catch (error) {
    console.error("Error fetching projects:", error);
    return res.status(500).json({ message: "Failed to fetch projects" });
  }
};

export const getProjectById = async (req, res) => {
  try {
    const project = await getOwnedProject(req.params.id, req.user?.id);
    if (!project) return res.status(404).json({ message: "Project not found" });

    return res.json({
      ...toPublicProject(project),
      envConfig: maskObjectValues(project.envConfig || {}),
    });
  } catch (error) {
    console.error("Error fetching project:", error);
    return res.status(500).json({ message: "Failed to fetch project" });
  }
};

export const deleteProject = async (req, res) => {
  try {
    const project = await getOwnedProject(req.params.id, req.user?.id);
    if (!project) return res.status(404).json({ message: "Project not found" });

    const activeStatuses = ["QUEUED", "BUILDING", "PUSHING", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "ROLLING_BACK", "DESTROYING"];
    const deletion = await prisma.$transaction(async (tx) => {
      const lockKey = `skyforge:project-deployments:${project.id}`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text AS acquired`;
      const inFlightDeployment = await tx.deployment.findFirst({
        where: { projectId: project.id, status: { in: activeStatuses } },
        select: { id: true, status: true },
      });
      if (inFlightDeployment) return { conflict: "active", deployment: inFlightDeployment };

      const undeployedResources = await tx.deployment.findFirst({
        where: { projectId: project.id, resources: { not: Prisma.AnyNull }, status: { not: "DESTROYED" } },
        select: { id: true, status: true },
      });
      if (undeployedResources) return { conflict: "resources", deployment: undeployedResources };

      await tx.deployment.deleteMany({ where: { projectId: project.id } });
      await tx.project.delete({ where: { id: project.id } });
      return { conflict: null };
    }, { timeout: 15_000 });

    if (deletion.conflict === "active") {
      return res.status(409).json({
        message: "A deployment or teardown is currently in progress. Wait for it to finish before deleting the project.",
        deploymentId: deletion.deployment.id,
        deploymentStatus: deletion.deployment.status,
        canForce: false,
      });
    }
    if (deletion.conflict === "resources") {
      return res.status(409).json({
        message: "This project still has recorded cloud resources. Destroy its infrastructure before deleting the project.",
        deploymentId: deletion.deployment.id,
        deploymentStatus: deletion.deployment.status,
        requiresTeardown: true,
      });
    }

    // Clean up local generated workspace artifacts
    const projectDir = path.resolve(GENERATED_DIR, project.id);
    if (projectDir.startsWith(`${GENERATED_DIR}${path.sep}`) && fs.existsSync(projectDir)) {
      try {
        fs.rmSync(projectDir, { recursive: true, force: true });
      } catch (rmErr) {
        console.warn(`[PROJECT] Could not remove workspace directory ${projectDir}:`, rmErr.message);
      }
    }

    return res.json({ message: "Project deleted successfully", id: project.id });
  } catch (error) {
    console.error("Error deleting project:", error);
    return res.status(500).json({ message: "Failed to delete project" });
  }
};
