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
import { planBuild, exposedPort } from "./buildPlanner.js";
import { ensurePortShim, wrapDockerfileWithShim, SHIM_CONTEXT_NAME } from "./portShim.js";
import { runCommand } from "./commandRunner.js";
import { isBlockedSecretFile } from "./secretFilePolicy.js";
import { createDockerIgnoreFilter } from "./dockerIgnoreFilter.js";
import { isMultiServiceProject, setupMultiServiceWorkspace } from "./multiServiceBuilder.js";
import { detectFullStack, writeFullStackWorkspace, frontendBuildDefaults, fullStackPublicPort } from "./fullStackBuilder.js";

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

async function extractArchive(buffer, archivePath, targetDir, limits) {
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(archivePath, buffer);
  try {
    await tar.x({
      file: archivePath,
      cwd: targetDir,
      strip: 1,
      strict: true,
      // Links could escape the workspace; skip them instead of rejecting the whole repository.
      filter: (_entryPath, entry) => entry.type !== "SymbolicLink" && entry.type !== "Link",
      onentry(entry) {
        const entryPath = String(entry.path || "").replace(/\\/g, "/");
        if (entryPath.startsWith("/") || entryPath.split("/").includes("..")) {
          throw new Error("Repository archive contains an unsafe path.");
        }
        limits.files += 1;
        limits.bytes += Number(entry.size || 0);
        if (limits.files > 50_000 || limits.bytes > 1024 * 1024 * 1024) {
          throw new Error("Repository archive exceeds deployment resource limits.");
        }
      },
    });
  } finally {
    await fs.rm(archivePath, { force: true });
  }
}

// GitHub tarballs omit submodules; fetch each GitHub-hosted one at its pinned commit.
async function fetchSubmodules({ sourceDir, owner, repo, ref, token, deploymentId, archivePath, limits }) {
  const gitmodules = await fs.readFile(path.join(sourceDir, ".gitmodules"), "utf-8").catch(() => "");
  if (!gitmodules) return;
  const modules = [];
  for (const block of gitmodules.split(/^\s*\[submodule\b/m).slice(1)) {
    const modulePath = block.match(/^\s*path\s*=\s*(.+?)\s*$/m)?.[1];
    const url = block.match(/^\s*url\s*=\s*(.+?)\s*$/m)?.[1];
    if (modulePath && url) modules.push({ modulePath, url });
  }
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "SkyForge-Deployment-Worker", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  for (const { modulePath, url } of modules.slice(0, 10)) {
    const log = (message, level = "info") => emitDeploymentLog(deploymentId, { stage: "CLONING", message: `[SOURCE] Submodule ${modulePath}: ${message}`, level });
    const target = path.resolve(sourceDir, modulePath);
    if (!target.startsWith(`${sourceDir}${path.sep}`) || modulePath.includes("..")) {
      log("skipped (unsafe path).", "warn");
      continue;
    }
    const resolvedUrl = url.startsWith("../") ? `https://github.com/${owner}/${url.replace(/^\.\.\//, "")}` : url;
    const match = resolvedUrl.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
    if (!match) {
      log(`skipped (only GitHub-hosted submodules are supported: ${url}).`, "warn");
      continue;
    }
    try {
      const encodedPath = modulePath.split("/").map(encodeURIComponent).join("/");
      const { data: pointer } = await axios.get(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, { headers, timeout: 30_000 });
      const sha = pointer?.type === "submodule" ? pointer.sha : null;
      const { data } = await axios.get(`https://api.github.com/repos/${match[1]}/${match[2]}/tarball${sha ? `/${sha}` : ""}`, {
        headers, responseType: "arraybuffer", timeout: 60_000, maxContentLength: 250 * 1024 * 1024,
      });
      await fs.rm(target, { recursive: true, force: true });
      await extractArchive(Buffer.from(data), `${archivePath}.sub`, target, limits);
      log(`fetched ${match[1]}/${match[2]}${sha ? `@${sha.slice(0, 7)}` : ""}.`);
    } catch (error) {
      log(`could not be fetched (${error.response?.status || error.message}); continuing without it.`, "warn");
    }
  }
}

export async function prepareRepository(project, deploymentId) {
  const deploymentDir = safeDeploymentDirectory(project.id, deploymentId);
  const sourceDir = path.join(deploymentDir, "source");
  const archivePath = path.join(deploymentDir, "source.tar.gz");
  await fs.rm(sourceDir, { recursive: true, force: true });
  await fs.mkdir(sourceDir, { recursive: true });

  const { owner, repo } = parseRepository(project);
  const configuredBranch = String(project.branch || "main").trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(configuredBranch) || configuredBranch.includes("..")) {
    throw new Error("A valid Git branch is required.");
  }
  let activeToken = await getRepositoryToken(project);
  let downloadedRef = null;
  let response;
  let lastError;
  // A missing branch falls back to main/master, then to the repository's default branch
  // (null). Every fallback is logged as a warning so the deployed source is never a surprise.
  const branchCandidates = [configuredBranch];
  if (configuredBranch !== "main") branchCandidates.push("main");
  if (configuredBranch !== "master") branchCandidates.push("master");
  branchCandidates.push(null);
  for (const [branchIndex, branch] of branchCandidates.entries()) {
    emitDeploymentLog(deploymentId, {
      stage: "CLONING",
      message: `[SOURCE] Downloading ${owner}/${repo}@${branch || "default branch"} from GitHub...`,
      level: "info",
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const downloadUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball${branch ? `/${encodeURIComponent(branch)}` : ""}`;
        response = await axios.get(downloadUrl, {
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
        if (error.response?.status === 404 && branchIndex < branchCandidates.length - 1) {
          emitDeploymentLog(deploymentId, {
            stage: "CLONING",
            message: `[SOURCE] Branch ${branch} was not found; trying ${branchCandidates[branchIndex + 1] ? `branch ${branchCandidates[branchIndex + 1]}` : "the repository's default branch"}...`,
            level: "warn",
          });
          break;
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
    if (response) {
      downloadedRef = branch;
      break;
    }
  }

  if (!response) {
    const status = lastError?.response?.status;
    throw new Error(`GitHub source download failed${status ? ` (${status})` : ""}: ${lastError?.message || "No response received."}`);
  }

  const limits = { files: 0, bytes: 0 };
  await extractArchive(Buffer.from(response.data), archivePath, sourceDir, limits);
  await fetchSubmodules({ sourceDir, owner, repo, ref: downloadedRef, token: activeToken, deploymentId, archivePath, limits });

  const entries = await fs.readdir(sourceDir);
  if (!entries.length) throw new Error("The downloaded repository is empty.");
  let fileCount = 0;
  let totalBytes = 0;
  const strippedFiles = [];
  async function assertSafeTree(directory, depth = 0) {
    if (depth > 20) throw new Error("Repository directory nesting exceeds the deployment limit.");
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(sourceDir, fullPath).split(path.sep).join("/");
      // Symlinks could point outside the workspace and credential files must not reach the image;
      // strip both rather than failing, since real repositories commonly contain them.
      if (entry.isSymbolicLink() || isBlockedSecretFile(entry.name) || /(^|\/)\.docker\/config\.json$/i.test(relativePath)) {
        await fs.rm(fullPath, { recursive: true, force: true });
        strippedFiles.push(relativePath);
        continue;
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
  if (strippedFiles.length) {
    emitDeploymentLog(deploymentId, {
      stage: "CLONING",
      message: `[SOURCE] Excluded ${strippedFiles.length} credential file(s) or symlink(s) from the build: ${strippedFiles.slice(0, 5).join(", ")}${strippedFiles.length > 5 ? ", ..." : ""}`,
      level: "warn",
    });
  }
  emitDeploymentLog(deploymentId, {
    stage: "CLONING",
    message: `[SOURCE] Repository archive extracted into an isolated build workspace.`,
    level: "success",
  });
  return sourceDir;
}

async function dockerBuild({ contextDir, dockerfilePath, imageTag, buildArgs, deploymentId, extraFiles = [] }) {
  // The Dockerfile must live inside the streamed context; generated ones are copied in temporarily.
  const inContext = path.dirname(dockerfilePath) === contextDir;
  const contextDockerfile = inContext ? path.basename(dockerfilePath) : ".skyforge.Dockerfile";
  if (!inContext) await fs.copyFile(dockerfilePath, path.join(contextDir, contextDockerfile));
  for (const file of extraFiles) await fs.copyFile(file.from, path.join(contextDir, file.name));
  const archivePath = path.join(os.tmpdir(), `skyforge-build-${deploymentId}-${Date.now()}.tar.gz`);
  let contextStream;
  try {
    const ignoreFilter = createDockerIgnoreFilter(contextDir, [contextDockerfile, ...extraFiles.map((file) => file.name)]);
    await tar.c({ gzip: true, file: archivePath, cwd: contextDir, portable: true, filter: ignoreFilter }, ["."]);
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
    if (!inContext) await fs.rm(path.join(contextDir, contextDockerfile), { force: true });
    for (const file of extraFiles) await fs.rm(path.join(contextDir, file.name), { force: true });
  }
}

/**
 * Builds the deployment image and returns { imageTag, dockerfile, port }.
 * The build plan is derived from the checked-out source (see buildPlanner.js). When a build
 * fails and another viable Dockerfile exists (generated vs. the repository's own), it is retried
 * with the alternative before the deployment fails.
 */
export async function buildContainerImage(project, deploymentId, sourceDir, imageTag) {
  const projectDir = safeProjectDirectory(project.id);
  const generatedDockerfile = path.join(projectDir, "Dockerfile.generated");
  const savedDockerfile = path.join(projectDir, "Dockerfile");
  const log = (message, level = "info") => emitDeploymentLog(deploymentId, { stage: "BUILDING", message, level });

  // client/ + server/ style repositories: build the frontend and the API into one container.
  const fullStack = project.dockerStrategy === "CUSTOM" ? null : detectFullStack(sourceDir);
  if (fullStack) {
    const publicPort = fullStackPublicPort(fullStack);
    log(`[BUILD] Detected a ${fullStack.summary}. Building the frontend and the API into one container (served on port ${publicPort}; API paths ${fullStack.backend.prefixes.slice(0, 6).join(", ")} and WebSockets go to the API on port ${fullStack.backend.port}).`);
    const publicEnv = Object.entries(decryptObjectValues(project.envConfig || {}))
      .filter(([key]) => /^(?:VITE_|NEXT_PUBLIC_|PUBLIC_|REACT_APP_|NUXT_PUBLIC_|EXPO_PUBLIC_|VUE_APP_)/.test(key));
    const { defaults, localhostFallbacks } = frontendBuildDefaults(sourceDir, fullStack, publicEnv.map(([key]) => key));
    for (const [key, value] of Object.entries(defaults)) {
      publicEnv.push([key, value]);
      log(`[BUILD] ${key} is not set; using ${value ? `"${value}"` : "an empty value"} (this site) so the browser reaches the deployed API instead of localhost.`);
    }
    if (localhostFallbacks.length) log(`[BUILD] Some frontend files fall back to http://localhost URLs (${localhostFallbacks.join(", ")}). Requests that use them will not reach the deployed API; set the matching VITE_/REACT_APP_ variable if a feature does not work.`, "warn");
    const dockerfilePath = writeFullStackWorkspace(sourceDir, fullStack, { publicPort, publicEnvKeys: publicEnv.map(([key]) => key) });
    log(`[BUILD] API start command: ${fullStack.backend.command.join(" ")}`);
    await dockerBuild({ contextDir: sourceDir, dockerfilePath, imageTag, buildArgs: publicEnv.flatMap(([key, value]) => ["--build-arg", `${key}=${String(value)}`]), deploymentId });
    return { imageTag, dockerfile: "fullstack", port: publicPort };
  }

  if (isMultiServiceProject(sourceDir)) {
    log("[BUILD] Detected multi-service microservice application. Synthesizing unified reverse-proxy gateway and inter-service container...");
    const gatewayPort = Number.parseInt(project.port || "80", 10) || 80;
    await setupMultiServiceWorkspace(sourceDir, gatewayPort);
    await dockerBuild({ contextDir: sourceDir, dockerfilePath: path.join(sourceDir, "Dockerfile.multiservice"), imageTag, buildArgs: [], deploymentId });
    return { imageTag, dockerfile: "multiservice", port: gatewayPort };
  }

  let plan = null;
  let planError = null;
  try {
    plan = planBuild(sourceDir);
    log(`[BUILD] Detected ${plan.summary}.`);
  } catch (error) {
    planError = error;
  }
  const contextDir = plan?.appRoot || sourceDir;
  const repositoryDockerfile = resolveDockerfile(contextDir) || resolveDockerfile(sourceDir);

  const publicBuildEnv = Object.entries(decryptObjectValues(project.envConfig || {}))
    .filter(([key]) => /^(?:VITE_|NEXT_PUBLIC_|PUBLIC_|REACT_APP_|NUXT_PUBLIC_|EXPO_PUBLIC_)/.test(key));
  const buildArgs = publicBuildEnv.flatMap(([key, value]) => ["--build-arg", `${key}=${String(value)}`]);

  const attempts = [];
  const repositoryAttempt = repositoryDockerfile && {
    kind: "repository",
    label: `repository ${path.relative(sourceDir, repositoryDockerfile).split(path.sep).join("/")}`,
    contextDir: path.dirname(repositoryDockerfile),
    dockerfilePath: repositoryDockerfile,
    port: exposedPort(repositoryDockerfile) || plan?.port || 8080,
  };
  const generatedAttempt = plan?.strategy === "generated" && {
    kind: "generated",
    label: "SkyForge-generated Dockerfile",
    contextDir,
    dockerfilePath: generatedDockerfile,
    port: plan.port,
    prepare: async () => {
      // Apps hard-coded to listen on localhost are bridged to the container address by the shim.
      let generated = generateDockerfile({ ...plan.metadata, id: project.id }, project.deploymentPlan || {});
      try {
        generatedAttempt.extraFiles = [{ name: SHIM_CONTEXT_NAME, from: await ensurePortShim() }];
        generated = wrapDockerfileWithShim(generated, plan.port);
      } catch (error) {
        log(`[BUILD] Port bridge unavailable (${error.message.slice(0, 120)}); building without it.`, "warn");
      }
      const lines = generated.split("\n");
      const firstFrom = lines.findIndex((line) => /^FROM\s/i.test(line.trim()));
      lines.splice(firstFrom >= 0 ? firstFrom + 1 : 0, 0, ...publicBuildEnv.flatMap(([key]) => [`ARG ${key}`, `ENV ${key}=$${key}`, ""]));
      await fs.writeFile(generatedDockerfile, lines.join("\n"), "utf-8");
      if (project.dockerStrategy !== "CUSTOM") await fs.writeFile(savedDockerfile, lines.join("\n"), "utf-8").catch(() => {});
    },
  };
  if (project.dockerStrategy === "CUSTOM" && fsSync.existsSync(savedDockerfile)) {
    attempts.push({ kind: "saved", label: "saved custom Dockerfile", contextDir, dockerfilePath: savedDockerfile, port: exposedPort(savedDockerfile) || plan?.port || Number(project.port) || 8080 });
  } else if (project.dockerStrategy === "EXISTING") {
    if (!repositoryAttempt) throw new Error("The selected EXISTING Docker strategy requires a Dockerfile in the checked-out repository.");
    attempts.push(repositoryAttempt, generatedAttempt);
  } else {
    attempts.push(generatedAttempt, repositoryAttempt);
  }
  const viable = attempts.filter(Boolean);
  if (!viable.length) throw planError || new Error("No Dockerfile could be generated or found for this repository.");

  const savedIgnore = path.join(projectDir, ".dockerignore");
  if (fsSync.existsSync(savedIgnore) && !fsSync.existsSync(path.join(contextDir, ".dockerignore"))) {
    await fs.copyFile(savedIgnore, path.join(contextDir, ".dockerignore"));
  }

  let lastError;
  for (const [index, attempt] of viable.entries()) {
    try {
      await attempt.prepare?.();
      log(`[DOCKER] Building ${imageTag} with the ${attempt.label}...`);
      await dockerBuild({ contextDir: attempt.contextDir, dockerfilePath: attempt.dockerfilePath, imageTag, buildArgs, deploymentId, extraFiles: attempt.extraFiles });
      return { imageTag, dockerfile: attempt.kind, port: attempt.port };
    } catch (error) {
      lastError = error;
      if (index < viable.length - 1) log(`[BUILD] Build with the ${attempt.label} failed (${error.message.slice(0, 160)}); retrying with the ${viable[index + 1].label}...`, "warn");
    }
  }
  throw lastError;
}

const STATIC_KIND = /\(SPA\)|^Frontend SPA$|^Static HTML$|^Jekyll$/;

/**
 * Builds a static site for S3 hosting: the same planner and Docker build as container deployments,
 * then the finished files are copied out of the nginx image. Returns the output directory.
 * Throws a clear error when the app needs a server (choose an ECS target instead).
 */
export async function buildStaticSite(project, deploymentId, sourceDir) {
  const plan = planBuild(sourceDir);
  if (plan.strategy !== "generated" || !STATIC_KIND.test(plan.metadata.framework)) {
    const kind = plan.metadata?.framework || "an app with its own Dockerfile";
    throw new Error(`S3 + CloudFront hosts static sites only, but this repository is ${kind}, which needs a server. Choose "ECS Fargate" or "ECS Fargate + CloudFront" on the Infrastructure page.`);
  }
  emitDeploymentLog(deploymentId, { stage: "BUILDING", message: `[BUILD] Detected ${plan.summary}; building static files for S3.`, level: "info" });
  const outputDir = path.join(safeDeploymentDirectory(project.id, deploymentId), "dist");
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  const dockerfilePath = path.join(safeProjectDirectory(project.id), "Dockerfile.static");
  const publicBuildEnv = Object.entries(decryptObjectValues(project.envConfig || {}))
    .filter(([key]) => /^(?:VITE_|NEXT_PUBLIC_|PUBLIC_|REACT_APP_|NUXT_PUBLIC_|GATSBY_)/.test(key));
  const lines = generateDockerfile({ ...plan.metadata, id: project.id }).split("\n");
  const firstFrom = lines.findIndex((line) => /^FROM\s/i.test(line.trim()));
  lines.splice(firstFrom + 1, 0, ...publicBuildEnv.flatMap(([key]) => [`ARG ${key}`, `ENV ${key}=$${key}`]));
  await fs.mkdir(path.dirname(dockerfilePath), { recursive: true });
  await fs.writeFile(dockerfilePath, lines.join("\n"), "utf-8");

  const imageTag = `skyforge-static-${String(deploymentId).toLowerCase().replace(/[^a-z0-9-]/g, "")}`;
  const container = `${imageTag}-extract`;
  await dockerBuild({
    contextDir: plan.appRoot,
    dockerfilePath,
    imageTag,
    buildArgs: publicBuildEnv.flatMap(([key, value]) => ["--build-arg", `${key}=${String(value)}`]),
    deploymentId,
  });
  try {
    await runCommand("docker", ["create", "--name", container, imageTag], { timeout: 60_000 });
    await runCommand("docker", ["cp", `${container}:/usr/share/nginx/html/.`, outputDir], { timeout: 300_000 });
  } finally {
    await runCommand("docker", ["rm", "-f", container], { timeout: 60_000 }).catch(() => {});
    await runCommand("docker", ["rmi", "-f", imageTag], { timeout: 60_000 }).catch(() => {});
  }
  await fs.rm(path.join(outputDir, "50x.html"), { force: true });
  if (!fsSync.existsSync(path.join(outputDir, "index.html"))) throw new Error("The static build produced no index.html.");
  return outputDir;
}
