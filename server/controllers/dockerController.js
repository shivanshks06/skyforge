import prisma from "../config/db.js";
import {
  generateDockerfile,
  generateDockerignore,
  saveGeneratedDockerFiles,
  getGeneratedDockerFiles,
} from "../services/templateEngine.js";
import { validateDockerfile } from "../services/dockerValidator.js";
import { requireOwnedProject } from "../services/ownershipService.js";
import { decryptSecret } from "../services/secretService.js";
import { getFile } from "../services/githubService.js";
import { toPublicProject } from "../services/projectSerializer.js";
import { assertProjectHasNoActiveOperation } from "../services/operationGuard.js";

async function getProjectDockerfile(project) {
  const [owner, repo] = String(project.repoName || "").split("/");
  if (!owner || !repo) return null;

  const account = await prisma.gitHubAccount.findUnique({ where: { userId: project.userId } });
  const token = account ? decryptSecret(account.accessToken) : null;
  return getFile(owner, repo, "Dockerfile", token, project.branch || "main");
}

export const getDockerConfig = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    await assertProjectHasNoActiveOperation(project.id);
    const hasExistingDocker = Boolean(project.dockerized);
    const currentStrategy = project.dockerStrategy || (hasExistingDocker ? "EXISTING" : "GENERATE");
    const diskFiles = getGeneratedDockerFiles(project.id);
    let dockerfile = currentStrategy === "GENERATE" ? null : diskFiles?.dockerfile;
    if (!dockerfile && currentStrategy === "EXISTING") {
      dockerfile = await getProjectDockerfile(project);
    }
    if (!dockerfile) {
      if (currentStrategy === "EXISTING") {
        return res.status(404).json({ message: "The repository Dockerfile could not be read from GitHub." });
      }
      dockerfile = generateDockerfile(project, project.deploymentPlan || {});
    }
    const dockerignore = diskFiles?.dockerignore || generateDockerignore(project);
    const validation = validateDockerfile(dockerfile);
    const saveResult = saveGeneratedDockerFiles(project.id, dockerfile, dockerignore);

    const updatedProject = await prisma.project.update({
      where: { id: project.id },
      data: {
        dockerStrategy: currentStrategy,
        dockerGenerated: true,
        dockerPath: saveResult.dockerPath,
        dockerValidation: validation,
        configVersion: { increment: 1 },
        status: project.status === "Planned" ? "Containerized" : project.status,
      },
    });

    return res.json({
      project: toPublicProject(updatedProject),
      strategy: currentStrategy,
      hasExistingDocker,
      dockerfile,
      dockerignore,
      validation,
      dockerPath: saveResult.dockerPath,
      dockerignorePath: saveResult.dockerignorePath,
    });
  } catch (error) {
    console.error("Error fetching Docker configuration:", error);
    return res.status(error.statusCode || 500).json({ message: "Failed to fetch Docker configuration" });
  }
};

export const updateDockerStrategy = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    await assertProjectHasNoActiveOperation(project.id);
    const strategy = String(req.body?.strategy || "").toUpperCase();
    if (!new Set(["GENERATE", "EXISTING"]).has(strategy)) {
      return res.status(400).json({ message: "Docker strategy must be GENERATE or EXISTING." });
    }
    if (strategy === "EXISTING" && !project.dockerized) {
      return res.status(400).json({ message: "This repository does not contain a detected Dockerfile." });
    }

    const repositoryDockerfile = strategy === "EXISTING" ? await getProjectDockerfile(project) : null;
    const dockerfile = strategy === "EXISTING" && repositoryDockerfile
      ? repositoryDockerfile
      : generateDockerfile(project, project.deploymentPlan || {});
    const dockerignore = generateDockerignore(project);
    const validation = validateDockerfile(dockerfile);

    if (strategy === "EXISTING" && !repositoryDockerfile) {
      return res.status(404).json({ message: "The repository Dockerfile could not be read from GitHub." });
    }
    if (!validation.isValid) {
      return res.status(422).json({ message: "Dockerfile validation failed.", validation });
    }

    const saveResult = saveGeneratedDockerFiles(project.id, dockerfile, dockerignore);
    const updatedProject = await prisma.project.update({
      where: { id: project.id },
      data: {
        dockerStrategy: strategy,
        dockerGenerated: true,
        dockerPath: saveResult.dockerPath,
        dockerValidation: validation,
        configVersion: { increment: 1 },
        status: project.status === "Planned" ? "Containerized" : project.status,
      },
    });

    return res.json({
      message: `Docker strategy switched to ${strategy}`,
      project: toPublicProject(updatedProject),
      strategy,
      dockerfile,
      dockerignore,
      validation,
      dockerPath: saveResult.dockerPath,
    });
  } catch (error) {
    console.error("Error updating Docker strategy:", error);
    return res.status(error.statusCode || 500).json({ message: "Failed to update Docker strategy" });
  }
};

export const validateDockerContent = async (req, res) => {
  try {
    await requireOwnedProject(req.params.id, req.user?.id);
    const content = String(req.body?.content || "");
    if (content.length > 100_000) return res.status(413).json({ message: "Dockerfile content is too large." });
    return res.json({ validation: validateDockerfile(content) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Failed to validate Dockerfile" });
  }
};

export const saveDockerFiles = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    await assertProjectHasNoActiveOperation(project.id);
    const dockerfile = String(req.body?.dockerfile || "");
    const dockerignore = String(req.body?.dockerignore || "");
    if (dockerfile.length > 100_000 || dockerignore.length > 100_000) {
      return res.status(413).json({ message: "Docker files are too large." });
    }

    const validation = validateDockerfile(dockerfile);
    if (!validation.isValid) {
      return res.status(422).json({ message: "Fix Dockerfile validation errors before saving.", validation });
    }

    const saveResult = saveGeneratedDockerFiles(project.id, dockerfile, dockerignore);
    const updatedProject = await prisma.project.update({
      where: { id: project.id },
      data: {
        dockerStrategy: "CUSTOM",
        dockerGenerated: true,
        dockerPath: saveResult.dockerPath,
        dockerValidation: validation,
        configVersion: { increment: 1 },
        status: project.status === "Planned" ? "Containerized" : project.status,
      },
    });

    return res.json({
      message: "Dockerfile and .dockerignore saved successfully",
      project: toPublicProject(updatedProject),
      strategy: "CUSTOM",
      dockerPath: saveResult.dockerPath,
      validation,
    });
  } catch (error) {
    console.error("Error saving Docker files:", error);
    return res.status(error.statusCode || 500).json({ message: "Failed to save Docker files" });
  }
};
