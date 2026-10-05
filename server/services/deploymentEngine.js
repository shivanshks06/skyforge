import { getRepositoryTreeWithRef, getFile } from "./githubService.js";
import { detectProject, IMPORTANT_FILES } from "./detectionEngine.js";
import { generateDeploymentPlan } from "./aiPlanner.js";
import { generateDockerfile } from "./templateEngine.js";
import { scanGitHubRepository } from "./envScanner.js";

const APP_MANIFESTS = ["package.json", "requirements.txt", "pyproject.toml", "Pipfile", "manage.py", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "Cargo.toml", "Gemfile", "Dockerfile", "index.html"];
const PREFERRED_DIRS = /^(backend|server|api|app|web|src|service)$/i;

/** null when the app is at the repository root; otherwise the shallowest folder that holds an app manifest. */
export function findAppDirectory(tree) {
  const has = (path) => tree.some((entry) => entry.type !== "tree" && entry.path === path);
  if (APP_MANIFESTS.some((name) => has(name))) return null;
  const candidates = new Map();
  for (const entry of tree) {
    if (entry.type === "tree") continue;
    const parts = entry.path.split("/");
    if (parts.length < 2 || parts.length > 3 || !APP_MANIFESTS.includes(parts.at(-1))) continue;
    const dir = parts.slice(0, -1).join("/");
    if (/(^|\/)(node_modules|vendor|examples?|tests?|docs?|\.github|samples?)(\/|$)/i.test(dir)) continue;
    candidates.set(dir, (candidates.get(dir) || 0) + 1);
  }
  const ranked = [...candidates.entries()].sort((a, b) =>
    a[0].split("/").length - b[0].split("/").length
    || Number(PREFERRED_DIRS.test(b[0])) - Number(PREFERRED_DIRS.test(a[0]))
    || b[1] - a[1]);
  return ranked[0]?.[0] || null;
}

export async function analyzeRepository({ owner, repo, branch = "main", token = null }) {
  const { tree: fullTree, ref: resolvedBranch } = await getRepositoryTreeWithRef(owner, repo, branch, token);
  if (!fullTree.length) throw new Error("Repository tree is empty or inaccessible.");

  // Apps kept in a subfolder (backend/, server/, app/...) are detected from that folder.
  const appDir = findAppDirectory(fullTree);
  const prefix = appDir ? `${appDir}/` : "";
  const tree = appDir
    ? fullTree.filter((entry) => entry.path.startsWith(prefix)).map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }))
    : fullTree;

  const filesToFetch = IMPORTANT_FILES.filter((file) => tree.some((entry) => entry.path === file));
  const sourceFiles = tree
    .filter((entry) => entry.type === "blob" && /\.(js|ts|jsx|tsx|py)$/.test(entry.path) && !/(^|\/)(node_modules|tests?|migrations)\//.test(entry.path))
    .slice(0, 8)
    .map((entry) => entry.path);
  const filesContent = {};

  await Promise.all([...new Set([...filesToFetch, ...sourceFiles])].map(async (filePath) => {
    const content = await getFile(owner, repo, `${prefix}${filePath}`, token, resolvedBranch);
    if (content !== null) filesContent[filePath] = content;
  }));

  const detection = await detectProject(tree, filesContent);
  if (appDir) detection.appDirectory = appDir;
  try {
    const envAnalysis = await scanGitHubRepository({ owner, repo, ref: resolvedBranch, token });
    if (envAnalysis) {
      detection.envAnalysis = { ...envAnalysis, ignored: [] };
      detection.requiredEnv = envAnalysis.variables.filter((variable) => variable.required).map((variable) => variable.name);
    }
  } catch (error) {
    console.warn(`[ANALYSIS] Environment scan skipped for ${owner}/${repo}: ${error.message}`);
  }
  const plan = await generateDeploymentPlan(detection);
  const dockerfile = filesContent.Dockerfile || generateDockerfile(detection, plan);
  return {
    repository: `${owner}/${repo}`,
    branch: resolvedBranch,
    requestedBranch: branch,
    treeCount: tree.length,
    detection,
    plan: { ...plan, dockerfile },
    blueprints: { dockerfile },
  };
}
