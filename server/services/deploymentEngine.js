import { getRepositoryTree, getFile } from "./githubService.js";
import { detectProject, IMPORTANT_FILES } from "./detectionEngine.js";
import { generateDeploymentPlan } from "./aiPlanner.js";

/**
 * Full Pipeline Execution for Repository Intelligence Engine
 */
export async function analyzeRepository({ owner, repo, branch = "main", token = null }) {
  // Stage 1: Get full recursive file tree from GitHub API
  const tree = await getRepositoryTree(owner, repo, branch, token);

  // Filter tree to locate important files
  const filesToFetch = IMPORTANT_FILES.filter((impFile) =>
    tree.some((f) => f.path === impFile)
  );

  // Stage 2: Fetch contents of detected important files in parallel
  const filesContent = {};
  await Promise.all(
    filesToFetch.map(async (filePath) => {
      const content = await getFile(owner, repo, filePath, token);
      if (content !== null) {
        filesContent[filePath] = content;
      }
    })
  );

  // Also check for any source files with process.env if tree is small
  const appFilesToFetch = tree
    .filter((f) => f.type === "blob" && (f.path.endsWith(".js") || f.path.endsWith(".ts") || f.path.endsWith(".py")))
    .slice(0, 5);

  await Promise.all(
    appFilesToFetch.map(async (f) => {
      if (!filesContent[f.path]) {
        const content = await getFile(owner, repo, f.path, token);
        if (content !== null) {
          filesContent[f.path] = content;
        }
      }
    })
  );

  // Stage 3: Run Deterministic Framework Detection Engine
  const detection = await detectProject(tree, filesContent);

  // Stage 4: Run AI Deployment Planner
  const plan = await generateDeploymentPlan(detection);

  return {
    repository: `${owner}/${repo}`,
    branch,
    treeCount: tree.length,
    detection,
    plan,
  };
}
