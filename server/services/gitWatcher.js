// Watches GitHub for new commits and pull requests:
//   auto-deploy   a push to a project's branch queues a deployment
//   previews      each open pull request gets its own temporary copy of the app, removed when the PR closes
// Runs every minute from the worker process. A GitHub webhook (POST /api/github/webhook) triggers the same check
// immediately when SkyForge is reachable from the internet.
import axios from "axios";
import { Prisma } from "@prisma/client";
import prisma from "../config/db.js";
import { decryptSecret } from "./secretService.js";
import { preflight, queueDeployment, queueProjectTeardown } from "./deploymentLauncher.js";

export const MAX_PREVIEWS = 3;
const ACTIVE = ["QUEUED", "BUILDING", "PUSHING", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "ROLLING_BACK", "DESTROYING"];
// Settings a preview copies from its parent so it builds and runs the same way.
const INHERITED = [
  "repoName", "githubUrl", "framework", "language", "packageManager", "buildTool", "buildCommand", "startCommand", "port",
  "dockerized", "requiredEnv", "envAnalysis", "envConfig", "cpu", "memory", "healthCheck", "deploymentPlan", "dockerStrategy",
  "dockerGenerated", "dockerPath", "dockerValidation", "infrastructureManifest", "deploymentTarget", "confidence", "buildMode", "databaseConfig",
];

async function githubFor(userId) {
  const account = await prisma.gitHubAccount.findUnique({ where: { userId } });
  let token = null;
  try {
    token = account ? decryptSecret(account.accessToken) : null;
  } catch {
    token = null;
  }
  return axios.create({
    baseURL: "https://api.github.com",
    timeout: 20_000,
    headers: { Accept: "application/vnd.github+json", "User-Agent": "SkyForge-Git-Watcher", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
}

function repoPath(project) {
  const [owner, repo] = String(project.repoName || "").split("/");
  if (!owner || !repo) throw new Error("Invalid repository name.");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** Newest commit on the project's branch: { sha, message, author }, or null. */
export async function headCommit(project, github = null) {
  const client = github || await githubFor(project.userId);
  const { data } = await client.get(`${repoPath(project)}/commits/${encodeURIComponent(project.branch || "main")}`);
  if (!data?.sha) return null;
  return { sha: data.sha, message: String(data.commit?.message || "").slice(0, 500), author: data.commit?.author?.name || data.author?.login || null };
}

async function saveWatch(projectId, patch) {
  const current = await prisma.project.findUnique({ where: { id: projectId }, select: { gitWatch: true } });
  await prisma.project.update({ where: { id: projectId }, data: { gitWatch: { ...(current?.gitWatch || {}), ...patch, checkedAt: new Date().toISOString() } } });
}

async function isBusy(projectId) {
  return Boolean(await prisma.deployment.findFirst({ where: { projectId, status: { in: ACTIVE } }, select: { id: true } }));
}

/** Deploys the project if its branch moved since the last check. Returns what happened, for logs and the API. */
async function autoDeploy(project, github) {
  const commit = await headCommit(project, github);
  if (!commit) return "no commits";
  const known = project.gitWatch?.headSha;
  if (!known) {
    // First look at this branch: remember where it is; only later pushes deploy.
    await saveWatch(project.id, { headSha: commit.sha, lastError: null });
    return "baseline";
  }
  if (known === commit.sha) return "unchanged";
  if (await isBusy(project.id)) return "busy"; // try again next minute
  const { blockers } = await preflight(project);
  if (blockers.length) {
    await saveWatch(project.id, { headSha: commit.sha, lastError: `Push ${commit.sha.slice(0, 7)} was not deployed: ${blockers[0]}` });
    return "blocked";
  }
  await queueDeployment(project, { trigger: "push", commit });
  await saveWatch(project.id, { headSha: commit.sha, lastError: null, lastDeployedSha: commit.sha });
  return "deployed";
}

function previewName(parent, number) {
  return `${String(parent.name).slice(0, 40)}-pr${number}`;
}

async function cleanupPreview(preview) {
  if (await isBusy(preview.id)) return "busy";
  const remaining = await prisma.deployment.findFirst({ where: { projectId: preview.id, resources: { not: Prisma.AnyNull }, status: { not: "DESTROYED" } }, select: { id: true } });
  if (remaining) {
    await queueProjectTeardown(preview);
    await prisma.project.update({ where: { id: preview.id }, data: { status: "Removing preview" } });
    return "destroying";
  }
  // Nothing left in AWS: forget the preview.
  await prisma.$transaction([
    prisma.deployment.deleteMany({ where: { projectId: preview.id } }),
    prisma.project.delete({ where: { id: preview.id } }),
  ]);
  return "removed";
}

/** Creates, updates and removes pull-request previews for one parent project. */
async function syncPreviews(parent, github) {
  const previews = await prisma.project.findMany({ where: { parentProjectId: parent.id } });
  let open = [];
  if (parent.previewsEnabled) {
    const { data } = await github.get(`${repoPath(parent)}/pulls`, { params: { state: "open", base: parent.branch || "main", per_page: 20 } });
    // Only branches of this repository: code from forks never runs with your secrets or AWS account.
    open = (data || []).filter((pull) => pull.head?.repo?.full_name?.toLowerCase() === parent.repoName.toLowerCase()).slice(0, MAX_PREVIEWS);
  }
  const results = [];
  for (const preview of previews) {
    if (!open.some((pull) => pull.number === preview.previewPr)) results.push(`#${preview.previewPr} ${await cleanupPreview(preview)}`);
  }
  for (const pull of open) {
    let preview = previews.find((item) => item.previewPr === pull.number);
    if (!preview) {
      const inherited = Object.fromEntries(INHERITED.map((key) => [key, parent[key] ?? undefined]));
      preview = await prisma.project.create({
        data: {
          ...inherited,
          name: previewName(parent, pull.number),
          branch: pull.head.ref,
          userId: parent.userId,
          parentProjectId: parent.id,
          previewPr: pull.number,
          status: "Preview",
          securityTier: "FREE",
          gitWatch: { title: String(pull.title || "").slice(0, 200), url: pull.html_url },
        },
      });
    }
    if (preview.gitWatch?.headSha === pull.head.sha || await isBusy(preview.id)) continue;
    const { blockers } = await preflight(preview);
    if (blockers.length) {
      await saveWatch(preview.id, { headSha: pull.head.sha, lastError: blockers[0] });
      continue;
    }
    await queueDeployment(preview, { trigger: "preview", commit: { sha: pull.head.sha, message: pull.title, author: pull.user?.login } });
    await saveWatch(preview.id, { headSha: pull.head.sha, title: String(pull.title || "").slice(0, 200), url: pull.html_url, lastError: null });
    results.push(`#${pull.number} deploying`);
  }
  return results;
}

/** One pass over every project that has auto-deploy or previews on (or leftover previews to clean up). */
export async function runGitWatch({ repoName = null } = {}) {
  const parents = await prisma.project.findMany({
    where: {
      parentProjectId: null,
      ...(repoName ? { repoName: { equals: repoName, mode: "insensitive" } } : {}),
      OR: [{ autoDeploy: true }, { previewsEnabled: true }, { id: { in: (await prisma.project.findMany({ where: { parentProjectId: { not: null } }, select: { parentProjectId: true } })).map((row) => row.parentProjectId) } }],
    },
  });
  const summary = [];
  for (const project of parents) {
    try {
      const github = await githubFor(project.userId);
      if (project.autoDeploy) summary.push(`${project.name}: ${await autoDeploy(project, github)}`);
      const previews = await syncPreviews(project, github);
      if (previews.length) summary.push(`${project.name} previews: ${previews.join(", ")}`);
    } catch (error) {
      const message = error.response?.status === 404 ? "GitHub could not find the repository or branch (reconnect GitHub for private repositories)." : String(error.message).slice(0, 200);
      await saveWatch(project.id, { lastError: message }).catch(() => {});
    }
  }
  return summary;
}

let running = false;
/** Starts the once-a-minute watcher. Returns a stop function. */
export function startGitWatcher(intervalMs = 60_000) {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runGitWatch();
      const notable = summary.filter((line) => !/: (unchanged|baseline|busy)$/.test(line));
      if (notable.length) console.log(`[GIT WATCH] ${notable.join("; ")}`);
    } catch (error) {
      console.warn(`[GIT WATCH] ${error.message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 5_000).unref?.();
  return () => clearInterval(timer);
}
