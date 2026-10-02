import { getRepositoryTreeWithRef, getFile } from "./githubService.js";
import { detectProject, IMPORTANT_FILES } from "./detectionEngine.js";
import { generateDeploymentPlan } from "./aiPlanner.js";
import { generateDockerfile } from "./templateEngine.js";
import { scanGitHubRepository } from "./envScanner.js";

export async function analyzeRepository({ owner, repo, branch = "main", token = null }) {
  const { tree, ref: resolvedBranch } = await getRepositoryTreeWithRef(owner, repo, branch, token);
  if (!tree.length) throw new Error("Repository tree is empty or inaccessible.");

  const filesToFetch = IMPORTANT_FILES.filter((file) => tree.some((entry) => entry.path === file));
  const sourceFiles = tree
    .filter((entry) => entry.type === "blob" && /\.(js|ts|jsx|tsx|py)$/.test(entry.path))
    .slice(0, 8)
    .map((entry) => entry.path);
  const filesContent = {};

  await Promise.all([...new Set([...filesToFetch, ...sourceFiles])].map(async (filePath) => {
    const content = await getFile(owner, repo, filePath, token, resolvedBranch);
    if (content !== null) filesContent[filePath] = content;
  }));

  const detection = await detectProject(tree, filesContent);
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
