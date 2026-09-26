import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";
import * as tar from "tar";
import prisma from "../config/db.js";
import { decryptSecret, decryptObjectValues } from "./secretService.js";
import { emitDeploymentLog } from "./logsService.js";
import { generateDockerfile } from "./templateEngine.js";
import { findFrontendWorkspace, packageJson } from "./frontendWorkspace.js";
import { runCommand, assertCommandAvailable } from "./commandRunner.js";
import { isBlockedSecretFile } from "./secretFilePolicy.js";
import { createDockerIgnoreFilter } from "./dockerIgnoreFilter.js";
import { isMultiServiceProject, setupMultiServiceWorkspace } from "./multiServiceBuilder.js";

function resolveDockerfile(dir) {
  if (!dir) return null;
  for (const name of ["Dockerfile", "dockerfile", "Dockerfile.prod", "dockerfile.prod"]) {
    const candidate = path.join(dir, name);
    if (fsSync.existsSync(candidate)) return candidate;
  }
  return null;
}

const GENERATED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../generated");

function safeProjectDirectory(projectId) {
  const directory = path.resolve(GENERATED_DIR, projectId);
  if (!directory.startsWith(`${GENERATED_DIR}${path.sep}`)) throw new Error("Invalid project workspace path.");
  return directory;
}

function safeDeploymentDirectory(projectId, deploymentId) {
  const id = String(deploymentId || "");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid deployment workspace path.");
  const directory = path.resolve(safeProjectDirectory(projectId), "deployments", id);
  if (!directory.startsWith(`${safeProjectDirectory(projectId)}${path.sep}`)) throw new Error("Invalid deployment workspace path.");
  return directory;
}

function parseRepository(project) {
  const value = String(project.githubUrl || project.repoName || "");
  const normalized = value
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error("A valid GitHub repository is required before deployment.");
  }
  const [owner, repo] = normalized.split("/");
  if (!owner || !repo || owner === "." || owner === ".." || repo === "." || repo === "..") {
    throw new Error("A valid GitHub repository is required before deployment.");
  }
  return { owner, repo };
}

async function getRepositoryToken(project) {
  const account = await prisma.gitHubAccount.findUnique({ where: { userId: project.userId } });
  return account ? decryptSecret(account.accessToken) : null;
}

export async function prepareRepository(project, deploymentId) {
  const deploymentDir = safeDeploymentDirectory(project.id, deploymentId);
  const sourceDir = path.join(deploymentDir, "source");
  const archivePath = path.join(deploymentDir, "source.tar.gz");
  await fs.rm(sourceDir, { recursive: true, force: true });
  await fs.mkdir(sourceDir, { recursive: true });

  const { owner, repo } = parseRepository(project);
  const branch = String(project.branch || "main").trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..")) {
    throw new Error("A valid Git branch is required.");
  }

  emitDeploymentLog(deploymentId, {
    stage: "CLONING",
    message: `[SOURCE] Downloading ${owner}/${repo}@${branch} from GitHub...`,
    level: "info",
  });

  let activeToken = await getRepositoryToken(project);
  let response;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await axios.get(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${encodeURIComponent(branch)}`, {
        responseType: "arraybuffer",
        timeout: 60_000,
        maxContentLength: 250 * 1024 * 1024,
        maxBodyLength: 250 * 1024 * 1024,
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "SkyForge-Deployment-Worker",
          ...(activeToken ? { Authorization: `Bearer ${activeToken}` } : {}),
        },
      });
      break;
    } catch (error) {
      lastError = error;
      if (activeToken && error.response?.status === 401) {
        emitDeploymentLog(deploymentId, {
          stage: "CLONING",
          message: `[SOURCE] Stored GitHub access token was rejected (401 Bad credentials). Retrying unauthenticated for public repository...`,
          level: "warn",
        });
        activeToken = null;
        continue;
      }
      if (attempt < 3 && (!error.response || error.response.status >= 500 || error.code === "ECONNRESET" || error.code === "ETIMEDOUT")) {
        emitDeploymentLog(deploymentId, {
          stage: "CLONING",
          message: `[SOURCE] Download attempt ${attempt} notice: ${error.message}; retrying in 2s...`,
          level: "warn",
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      const status = error.response?.status;
      throw new Error(`GitHub source download failed${status ? ` (${status})` : ""}: ${error.message}`);
    }
  }

  await fs.writeFile(archivePath, Buffer.from(response.data));
  let archiveFileCount = 0;
  let archiveBytes = 0;
  try {
    await tar.x({
      file: archivePath,
      cwd: sourceDir,
      strip: 1,
      strict: true,
      onentry(entry) {
        const entryPath = String(entry.path || "").replace(/\\/g, "/");
        if (entryPath.startsWith("/") || entryPath.split("/").includes("..")) {
          throw new Error("Repository archive contains an unsafe path.");
        }
        archiveFileCount += 1;
        archiveBytes += Number(entry.size || 0);
        if (archiveFileCount > 50_000 || archiveBytes > 1024 * 1024 * 1024) {
          throw new Error("Repository archive exceeds deployment resource limits.");
        }
        if (entry.type === "SymbolicLink" || entry.type === "Link") {
          throw new Error("Symbolic links and hard links are not allowed in repository workspaces.");
        }
      },
    });
  } finally {
    await fs.rm(archivePath, { force: true });
  }

  const entries = await fs.readdir(sourceDir);
  if (!entries.length) throw new Error("The downloaded repository is empty.");
  let fileCount = 0;
  let totalBytes = 0;
  async function assertSafeTree(directory, depth = 0) {
    if (depth > 20) throw new Error("Repository directory nesting exceeds the deployment limit.");
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in repository workspaces: ${entry.name}`);
      const relativePath = path.relative(sourceDir, fullPath).split(path.sep).join("/");
      if (isBlockedSecretFile(entry.name) || /(^|\/)\.docker\/config\.json$/i.test(relativePath)) {
        throw new Error(`Secret-like files cannot enter a deployment workspace: ${relativePath}`);
      }
      if (entry.isDirectory()) await assertSafeTree(fullPath, depth + 1);
      else if (entry.isFile()) {
        fileCount += 1;
        totalBytes += (await fs.stat(fullPath)).size;
        if (fileCount > 50_000 || totalBytes > 1024 * 1024 * 1024) throw new Error("Repository exceeds deployment resource limits.");
      } else throw new Error(`Unsupported repository file type: ${entry.name}`);
    }
  }
  await assertSafeTree(sourceDir);
  emitDeploymentLog(deploymentId, {
    stage: "CLONING",
    message: `[SOURCE] Repository archive extracted into an isolated build workspace.`,
    level: "success",
  });
  return sourceDir;
}

function hostBuildsAllowed() {
  return process.env.ALLOW_HOST_BUILDS === "true" && process.env.NODE_ENV !== "production";
}

function packageManagerFor(pkg = {}, directory) {
  const declared = String(pkg.packageManager || "").split("@")[0].trim().toLowerCase();
  if (["npm", "yarn", "pnpm", "bun"].includes(declared)) return declared;
  if (fsSync.existsSync(path.join(directory, "bun.lockb")) || fsSync.existsSync(path.join(directory, "bun.lock"))) return "bun";
  if (fsSync.existsSync(path.join(directory, "pnpm-lock.yaml"))) return "pnpm";
  if (fsSync.existsSync(path.join(directory, "yarn.lock"))) return "yarn";
  return "npm";
}

function installScript(packageManager, directory) {
  const args = installCommandArgs(packageManager, directory);
  return [packageManager, ...args].join(" ");
}

function installCommandArgs(packageManager, directory) {
  const hasNpmLock = ["package-lock.json", "npm-shrinkwrap.json"].some((file) => fsSync.existsSync(path.join(directory, file)));
  const hasPnpmLock = fsSync.existsSync(path.join(directory, "pnpm-lock.yaml"));
  const hasYarnLock = fsSync.existsSync(path.join(directory, "yarn.lock"));
  const hasBunLock = ["bun.lock", "bun.lockb"].some((file) => fsSync.existsSync(path.join(directory, file)));
  if (packageManager === "bun") return hasBunLock ? ["install", "--frozen-lockfile"] : ["install"];
  if (packageManager === "pnpm") return hasPnpmLock ? ["install", "--frozen-lockfile"] : ["install"];
  if (packageManager === "yarn") return hasYarnLock ? ["install", "--frozen-lockfile"] : ["install"];
  return hasNpmLock ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"];
}

function useWorkerDockerVolumes() {
  return process.env.SKYFORGE_DOCKER_VOLUMES_FROM === "true" && Boolean(process.env.HOSTNAME);
}

function shellQuote(value) {
  const normalized = String(value).replace(/\\/g, "/");
  return `'${normalized.replace(/'/g, "'\\''")}'`;
}

async function runWorkerIsolatedFrontendBuild({
  deploymentId,
  workerId,
  sourcePath,
  outputPath,
  image,
  packageManager,
  publicBuildEnv,
  timeout,
  onLine,
}) {
  if (!workerId) throw new Error("A worker container identity is required for isolated frontend builds.");
  const suffix = String(deploymentId).replace(/[^a-zA-Z0-9_.-]/g, "-");
  const sourceVolume = `skyforge-build-source-${suffix}`;
  const outputVolume = `skyforge-build-output-${suffix}`;
  const sourceContainer = `skyforge-build-source-${suffix}`;
  const buildContainer = `skyforge-build-run-${suffix}`;
  const outputContainer = `skyforge-build-output-${suffix}`;
  const dockerEnvArgs = publicBuildEnv.map(([key, value]) => ["-e", `${key}=${String(value)}`]).flat();
  const sourcePathQuoted = shellQuote(sourcePath);
  const outputPathQuoted = shellQuote(outputPath);
  const buildScript = [
    "set -eu",
    "find /output -mindepth 1 -maxdepth 1 -exec rm -rf {} +",
    "rm -rf /tmp/skyforge-build",
    "mkdir -p /tmp/skyforge-build",
    "cp -R /workspace/. /tmp/skyforge-build/",
    "cd /tmp/skyforge-build",
    "rm -rf dist build out",
    ...(packageManager === "npm" ? [] : packageManager === "bun" ? ["npm install --global bun@1"] : ["corepack enable"]),
    installScript(packageManager, sourcePath),
    `${packageManager} run build`,
    "if [ -d dist ]; then cp -R dist/. /output/; elif [ -d build ]; then cp -R build/. /output/; elif [ -d out ]; then cp -R out/. /output/; else echo 'No supported build output directory was produced' >&2; exit 1; fi",
  ].join(" && ");

  try {
    await runCommand("docker", ["volume", "create", sourceVolume], { timeout: 30_000 });
    await runCommand("docker", ["volume", "create", outputVolume], { timeout: 30_000 });
    await runCommand("docker", [
      "run", "--rm", "--name", sourceContainer, "--volumes-from", `${workerId}:ro`,
      "-v", `${sourceVolume}:/workspace`, "-w", "/workspace", image,
      "sh", "-lc", `find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf {} + && cp -R ${sourcePathQuoted}/. /workspace/`,
    ], { timeout: 60_000, onLine });
    await runCommand("docker", [
      "run", "--rm", "--init", "--name", buildContainer,
      "-v", `${sourceVolume}:/workspace:ro`,
      "-v", `${outputVolume}:/output`,
      "-w", "/workspace", "-e", "CI=false", ...dockerEnvArgs, image,
      "sh", "-lc", buildScript,
    ], { timeout, onLine });
    await runCommand("docker", [
      "run", "--rm", "--name", outputContainer, "--volumes-from", workerId,
      "-v", `${outputVolume}:/output`, image,
      "sh", "-lc", `rm -rf ${outputPathQuoted} && mkdir -p ${outputPathQuoted} && cp -R /output/. ${outputPathQuoted}/`,
    ], { timeout: 60_000, onLine });
  } finally {
    await runCommand("docker", ["rm", "-f", sourceContainer, buildContainer, outputContainer], { timeout: 30_000 }).catch(() => {});
    await runCommand("docker", ["volume", "rm", "-f", sourceVolume], { timeout: 30_000 }).catch(() => {});
    await runCommand("docker", ["volume", "rm", "-f", outputVolume], { timeout: 30_000 }).catch(() => {});
  }
}

async function copyDirectory(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in deployable output: ${entry.name}`);
    if (isBlockedSecretFile(entry.name)) throw new Error(`Secret-like files cannot be published: ${entry.name}`);
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await fs.copyFile(from, to);
    else throw new Error(`Unsupported file type in deployable output: ${entry.name}`);
  }
}

export async function buildStaticAssets(project, deploymentId, sourceDir) {
  const outputDir = path.join(safeDeploymentDirectory(project.id, deploymentId), "dist");
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  const workspace = findFrontendWorkspace(sourceDir);
  if (!workspace) throw new Error("No frontend entry point or package build script was found.");

  if (workspace.type === "STATIC") {
    await copyDirectory(workspace.directory, outputDir);
  } else {
    const packageDirectory = workspace.directory;
    const pkg = packageJson(packageDirectory) || workspace.pkg || {};
    const packageManager = packageManagerFor(pkg, packageDirectory);
    const publicBuildEnv = Object.entries(decryptObjectValues(project.envConfig || {}))
      .filter(([key]) => /^(?:VITE_|NEXT_PUBLIC_|PUBLIC_)/.test(key));

    // Repository scripts are untrusted. Production builds must remain containerized.
    let dockerSuccess = false;
    const dockerAvailable = await assertCommandAvailable("docker");

    if (dockerAvailable) {
      try {
        const image = process.env.SKYFORGE_BUILDER_IMAGE || "node:22-bookworm-slim";
        const timeout = Number.parseInt(process.env.BUILD_TIMEOUT_MS || "600000", 10);
        const onLine = (line) => emitDeploymentLog(deploymentId, {
          stage: "BUILDING",
          message: `[BUILD] ${line.slice(0, 240)}`,
          level: /error|failed|fatal/i.test(line) ? "warn" : "info",
        });

        emitDeploymentLog(deploymentId, {
          stage: "BUILDING",
          message: `[BUILD] Running the project build in an isolated ${image} container...`,
          level: "info",
        });

        if (useWorkerDockerVolumes()) {
          await runWorkerIsolatedFrontendBuild({
            deploymentId,
            workerId: process.env.HOSTNAME,
            sourcePath: packageDirectory,
            outputPath: outputDir,
            image,
            packageManager,
            publicBuildEnv,
            timeout,
            onLine,
          });
        } else {
          const dockerEnvArgs = publicBuildEnv.map(([key, value]) => ["-e", `${key}=${String(value)}`]).flat();
          const script = [
            "set -eu",
            "rm -rf /tmp/skyforge-build",
            "mkdir -p /tmp/skyforge-build",
            "cp -R /workspace/. /tmp/skyforge-build/",
            "cd /tmp/skyforge-build",
            "rm -rf dist build out",
            ...(packageManager === "npm" ? [] : packageManager === "bun" ? ["npm install --global bun@1"] : ["corepack enable"]),
            installScript(packageManager, packageDirectory),
            `${packageManager} run build`,
            "if [ -d dist ]; then cp -R dist/. /output/; elif [ -d build ]; then cp -R build/. /output/; elif [ -d out ]; then cp -R out/. /output/; else echo 'No supported build output directory was produced' >&2; exit 1; fi",
          ].join(" && ");

          const containerName = `skyforge-build-${String(deploymentId).replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
          try {
            await runCommand("docker", [
              "run", "--rm", "--init", "--name", containerName,
              "-v", `${path.resolve(packageDirectory)}:/workspace:ro`,
              "-v", `${path.resolve(outputDir)}:/output`,
              "-w", "/workspace",
              "-e", "CI=false",
              ...dockerEnvArgs,
              image,
              "sh", "-lc", script,
            ], { timeout, onLine });
          } finally {
            await runCommand("docker", ["rm", "-f", containerName], { timeout: 30_000 }).catch(() => {});
          }
        }
        dockerSuccess = true;
      } catch (dockerError) {
        if (!hostBuildsAllowed()) {
          throw new Error(`Isolated container build failed: ${dockerError.message}`);
        }
        emitDeploymentLog(deploymentId, {
          stage: "BUILDING",
          message: `[BUILD] Docker build failed: ${dockerError.message.slice(0, 200)}. Falling back to an explicitly enabled development host build...`,
          level: "warn",
        });
      }
    } else if (hostBuildsAllowed()) {
      emitDeploymentLog(deploymentId, {
        stage: "BUILDING",
        message: "[BUILD] Docker is not available. Using an explicitly enabled development host build...",
        level: "warn",
      });
    } else {
      throw new Error("Docker is required for isolated frontend builds. Set ALLOW_HOST_BUILDS=true only in a disposable development environment.");
    }

    if (!dockerSuccess) {
      if (!hostBuildsAllowed()) throw new Error("An isolated frontend build could not be completed.");
      for (const candidate of ["dist", "build", "out"]) {
        await fs.rm(path.join(packageDirectory, candidate), { recursive: true, force: true });
      }
      emitDeploymentLog(deploymentId, {
        stage: "BUILDING",
        message: `[BUILD] Installing dependencies with ${packageManager} in ${path.basename(packageDirectory)}...`,
        level: "info",
      });

      const envOverrides = { ...process.env, CI: "false" };
      for (const [key, value] of publicBuildEnv) {
        envOverrides[key] = String(value);
      }

      await runCommand(packageManager, installCommandArgs(packageManager, packageDirectory), {
        cwd: packageDirectory,
        env: envOverrides,
        timeout: Number.parseInt(process.env.BUILD_TIMEOUT_MS || "600000", 10),
        onLine: (line) => emitDeploymentLog(deploymentId, {
          stage: "BUILDING",
          message: `[${packageManager.toUpperCase()}] ${line.slice(0, 240)}`,
          level: /error|warn/i.test(line) ? "warn" : "info",
        }),
      });

      emitDeploymentLog(deploymentId, {
        stage: "BUILDING",
        message: `[BUILD] Running ${packageManager} run build...`,
        level: "info",
      });

      await runCommand(packageManager, ["run", "build"], {
        cwd: packageDirectory,
        env: envOverrides,
        timeout: Number.parseInt(process.env.BUILD_TIMEOUT_MS || "600000", 10),
        onLine: (line) => emitDeploymentLog(deploymentId, {
          stage: "BUILDING",
          message: `[BUILD] ${line.slice(0, 240)}`,
          level: /error|failed|fatal/i.test(line) ? "warn" : "info",
        }),
      });

      // Copy build output to the deployment dist directory
      const buildOutputCandidates = ["dist", "build", "out"];
      let foundOutput = false;
      for (const candidate of buildOutputCandidates) {
        const candidatePath = path.join(packageDirectory, candidate);
        if (fsSync.existsSync(candidatePath) && fsSync.statSync(candidatePath).isDirectory()) {
          await copyDirectory(candidatePath, outputDir);
          foundOutput = true;
          emitDeploymentLog(deploymentId, {
            stage: "BUILDING",
            message: `[BUILD] Copied build output from ${candidate}/ directory.`,
            level: "success",
          });
          break;
        }
      }
      if (!foundOutput) {
        throw new Error("No supported build output directory (dist/, build/, out/) was produced by npm run build.");
      }
    }

    if (!fsSync.existsSync(path.join(outputDir, "index.html"))) {
      throw new Error("The project build completed without producing an index.html file.");
    }
  }

  if (!fsSync.existsSync(path.join(outputDir, "index.html"))) {
    throw new Error("The static build did not produce index.html.");
  }
  return outputDir;
}

export async function buildContainerImage(project, deploymentId, sourceDir, imageTag) {
  const projectDir = safeProjectDirectory(project.id);
  const generatedDockerfile = path.join(projectDir, "Dockerfile.generated");
  const savedDockerfile = path.join(projectDir, "Dockerfile");

  if (isMultiServiceProject(sourceDir)) {
    emitDeploymentLog(deploymentId, {
      stage: "BUILDING",
      message: "[BUILD] Detected multi-service microservice application. Synthesizing unified reverse-proxy gateway and inter-service container...",
      level: "info",
    });
    const gatewayPort = Number.parseInt(project.port || "80", 10) || 80;
    await setupMultiServiceWorkspace(sourceDir, gatewayPort);
    const contextDockerfile = "Dockerfile.multiservice";
    const archivePath = path.join(os.tmpdir(), `skyforge-build-${deploymentId}-${Date.now()}.tar.gz`);
    let contextStream;
    try {
      const ignoreFilter = createDockerIgnoreFilter(sourceDir, [contextDockerfile, "skyforge-gateway.mjs", "skyforge-dns.cjs"]);
      await tar.c({ gzip: true, file: archivePath, cwd: sourceDir, portable: true, filter: ignoreFilter }, ["."]);
      contextStream = fsSync.createReadStream(archivePath);
      await runCommand("docker", [
        "build", "--pull", "-t", imageTag, "-f", contextDockerfile, "-",
      ], {
        input: contextStream,
        timeout: Number.parseInt(process.env.BUILD_TIMEOUT_MS || "900000", 10),
        onLine: (line) => emitDeploymentLog(deploymentId, {
          stage: "BUILDING",
          message: `[DOCKER] ${line.slice(0, 240)}`,
          level: /error|failed|fatal/i.test(line) ? "warn" : "info",
        }),
      });
    } finally {
      contextStream?.destroy();
      await fs.rm(archivePath, { force: true });
    }
    return { imageTag, dockerfile: "multiservice" };
  }

  const rootRepositoryDockerfile = resolveDockerfile(sourceDir);
  const rootHasPackage = fsSync.existsSync(path.join(sourceDir, "package.json"));
  const detectedWorkspace = (rootRepositoryDockerfile || rootHasPackage) ? null : findFrontendWorkspace(sourceDir);
  const contextSourceDir = detectedWorkspace?.directory || sourceDir;
  const repositoryDockerfile = resolveDockerfile(contextSourceDir);
  if (project.dockerStrategy === "EXISTING" && !repositoryDockerfile) {
    throw new Error("The selected EXISTING Docker strategy requires a Dockerfile in the checked-out repository.");
  }
  const useRepositoryDockerfile = project.dockerStrategy === "EXISTING" && Boolean(repositoryDockerfile);
  const useSavedDockerfile = !useRepositoryDockerfile && process.env.REGENERATE_DOCKERFILE !== "true" && fsSync.existsSync(savedDockerfile);
  const dockerfile = useRepositoryDockerfile ? repositoryDockerfile : useSavedDockerfile ? savedDockerfile : generatedDockerfile;

  const savedIgnore = path.join(projectDir, ".dockerignore");
  if (fsSync.existsSync(savedIgnore)) await fs.copyFile(savedIgnore, path.join(contextSourceDir, ".dockerignore"));

  const publicBuildEnv = Object.entries(decryptObjectValues(project.envConfig || {}))
    .filter(([key]) => /^(?:VITE_|NEXT_PUBLIC_|PUBLIC_)/.test(key));
  if (!useRepositoryDockerfile && !useSavedDockerfile) {
    const generated = generateDockerfile(project, project.deploymentPlan || {});
    const buildEnvLines = publicBuildEnv.flatMap(([key]) => [`ARG ${key}`, `ENV ${key}=$${key}`, ""]);
    const generatedLines = generated.split("\n");
    const firstFrom = generatedLines.findIndex((line) => /^FROM\s/i.test(line.trim()));
    generatedLines.splice(firstFrom >= 0 ? firstFrom + 1 : 0, 0, ...buildEnvLines);
    await fs.writeFile(generatedDockerfile, generatedLines.join("\n"), "utf-8");
  }

  const buildArgs = publicBuildEnv.flatMap(([key, value]) => ["--build-arg", `${key}=${String(value)}`]);

  emitDeploymentLog(deploymentId, {
    stage: "BUILDING",
    message: `[DOCKER] Building ${imageTag} from an isolated repository workspace...`,
    level: "info",
  });
  const contextDockerfile = useRepositoryDockerfile ? "Dockerfile" : ".skyforge.Dockerfile";
  const temporaryDockerfile = path.join(contextSourceDir, contextDockerfile);
  if (!useRepositoryDockerfile) await fs.copyFile(dockerfile, temporaryDockerfile);
  const archivePath = path.join(os.tmpdir(), `skyforge-build-${deploymentId}-${Date.now()}.tar.gz`);
  let contextStream;
  try {
    const ignoreFilter = createDockerIgnoreFilter(contextSourceDir, [contextDockerfile]);
    await tar.c({ gzip: true, file: archivePath, cwd: contextSourceDir, portable: true, filter: ignoreFilter }, ["."]);
    contextStream = fsSync.createReadStream(archivePath);
    await runCommand("docker", [
      "build", "--pull", ...buildArgs, "-t", imageTag, "-f", contextDockerfile, "-",
    ], {
      input: contextStream,
      timeout: Number.parseInt(process.env.BUILD_TIMEOUT_MS || "900000", 10),
      onLine: (line) => emitDeploymentLog(deploymentId, {
        stage: "BUILDING",
        message: `[DOCKER] ${line.slice(0, 240)}`,
        level: /error|failed|fatal/i.test(line) ? "warn" : "info",
      }),
    });
  } finally {
    contextStream?.destroy();
    await fs.rm(archivePath, { force: true });
    if (!useRepositoryDockerfile) await fs.rm(temporaryDockerfile, { force: true });
  }
  return { imageTag, dockerfile: useRepositoryDockerfile ? "repository" : useSavedDockerfile ? "saved" : "generated" };
}
