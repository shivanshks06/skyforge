import axios from "axios";
import { GoogleGenAI } from "@google/genai";
import { AI_MODEL } from "./aiPlanner.js";

/**
 * Security fix pull requests. Well-known issues get deterministic fixes; other findings are fixed
 * by Gemini, restricted to replacing lines near the finding. The change is committed to a new
 * branch. On repositories the user can push to, a pull request is opened; on others the branch
 * goes to the user's fork and a compare link is returned (SkyForge never opens pull requests on
 * third-party repositories by itself).
 */

const GITHUB = "https://api.github.com";

function ensurePythonImport(lines, module = "os") {
  if (lines.some((line) => new RegExp(`^\\s*import\\s+${module}\\b|^\\s*from\\s+${module}\\s+import`).test(line))) return lines;
  const insertAt = lines.findIndex((line) => !/^\s*(#|$|"""|''')/.test(line));
  return [...lines.slice(0, Math.max(insertAt, 0)), `import ${module}`, ...lines.slice(Math.max(insertAt, 0))];
}

/** Returns { content, envVars, summary } or null when no deterministic fix applies. */
const FIX_TARGETS = {
  "django-debug": /^\s*DEBUG\s*=\s*True\b/,
  "django-secret-key": /^\s*SECRET_KEY\s*=\s*['"]/,
  "flask-debug": /\.run\([^)]*debug\s*=\s*True/,
};

export function deterministicFix(finding, content) {
  const target = FIX_TARGETS[finding.rule];
  if (!target) return null;
  const lines = content.split("\n");
  // The file may have changed since the scan: trust the reported line only if it still matches.
  const reported = Number.parseInt(String(finding.location || "").split(":").pop(), 10) - 1;
  const index = target.test(lines[reported] || "") ? reported : lines.findIndex((line) => target.test(line));
  if (index < 0) return null;
  const indent = lines[index].match(/^\s*/)[0];
  if (finding.rule === "django-debug") {
    lines[index] = `${indent}DEBUG = os.environ.get("DJANGO_DEBUG", "False").lower() == "true"`;
    return { content: ensurePythonImport(lines).join("\n"), envVars: [], summary: "DEBUG now defaults to False and can be enabled with DJANGO_DEBUG=true." };
  }
  if (finding.rule === "django-secret-key") {
    lines[index] = `${indent}SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]`;
    return { content: ensurePythonImport(lines).join("\n"), envVars: ["DJANGO_SECRET_KEY"], summary: "SECRET_KEY is read from the DJANGO_SECRET_KEY environment variable (set a new random value; the old key is public)." };
  }
  if (finding.rule === "flask-debug") {
    lines[index] = lines[index].replace(/debug\s*=\s*True/, 'debug=os.environ.get("FLASK_DEBUG") == "1"');
    return { content: ensurePythonImport(lines).join("\n"), envVars: [], summary: "Flask debug mode is off unless FLASK_DEBUG=1." };
  }
  return null;
}

async function aiFix(finding, content, path) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("No deterministic fix exists for this finding and GEMINI_API_KEY is not configured for AI fixes.");
  const lines = content.split("\n");
  const target = Number.parseInt(String(finding.location || "").split(":").pop(), 10) || 1;
  const from = Math.max(1, target - 6);
  const to = Math.min(lines.length, target + 6);
  const excerpt = lines.slice(from - 1, to).map((line, offset) => `${from + offset}: ${line}`).join("\n");
  const prompt = `You fix one security issue in a source file with the smallest possible change.
File: ${path}
Issue: ${finding.title}. ${finding.detail || ""} Suggested fix: ${finding.fix || ""}
Lines ${from}-${to} (number: text):
${excerpt}

Rules: replace hard-coded secrets with an environment variable read in the file's language (Python os.environ, JavaScript process.env, Ruby ENV.fetch, PHP getenv, Go os.Getenv, Java System.getenv). Never output the secret value. Only change lines between ${from} and ${to}. Keep indentation.
Return JSON only: {"replacements":[{"line":<number>,"text":"<new line text>"}],"envVars":["NAME"],"summary":"<one sentence>"}`;
  const ai = new GoogleGenAI({ apiKey });
  for (const model of [...new Set([AI_MODEL, "gemini-flash-lite-latest", "gemini-flash-latest"])]) {
    try {
      const response = await ai.models.generateContent({ model, contents: prompt, config: { responseMimeType: "application/json", temperature: 0 } });
      const parsed = JSON.parse(String(response?.text || "").replace(/```json|```/g, "").trim());
      const replacements = Array.isArray(parsed?.replacements) ? parsed.replacements : [];
      if (!replacements.length || replacements.some((item) => !Number.isInteger(item.line) || item.line < from || item.line > to || typeof item.text !== "string" || /\n/.test(item.text))) continue;
      const next = [...lines];
      for (const item of replacements) next[item.line - 1] = item.text;
      return {
        content: next.join("\n"),
        envVars: (Array.isArray(parsed.envVars) ? parsed.envVars : []).filter((name) => /^[A-Z_][A-Z0-9_]*$/.test(name)).slice(0, 5),
        summary: String(parsed.summary || "Moved the hard-coded value to an environment variable.").slice(0, 300),
      };
    } catch {
      // try the next model
    }
  }
  throw new Error("The AI could not produce a safe fix for this finding.");
}

/**
 * Creates a branch with the fix and, when the user can push to the repository, a pull request.
 * Returns { url, kind: "pull_request" | "fork_branch", branch, summary, envVars }.
 */
export async function createFixPullRequest({ token, repoName, branch, finding }) {
  if (!token) throw new Error("Connect GitHub to create fix pull requests.");
  if (!finding?.path || !finding.fixable) throw new Error("This finding cannot be fixed automatically.");
  const [owner, repo] = repoName.split("/");
  const gh = axios.create({ baseURL: GITHUB, timeout: 30_000, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "SkyForge-Security" } });
  const encodePath = (value) => value.split("/").map(encodeURIComponent).join("/");

  const { data: upstream } = await gh.get(`/repos/${owner}/${repo}`);
  const baseBranch = branch || upstream.default_branch;
  const { data: file } = await gh.get(`/repos/${owner}/${repo}/contents/${encodePath(finding.path)}`, { params: { ref: baseBranch } });
  const original = Buffer.from(file.content, "base64").toString("utf-8");
  const fix = deterministicFix(finding, original) || await aiFix(finding, original, finding.path);
  if (fix.content === original) throw new Error("The fix produced no change.");

  let targetOwner = owner;
  const canPush = Boolean(upstream.permissions?.push);
  if (!canPush) {
    const { data: fork } = await gh.post(`/repos/${owner}/${repo}/forks`, {});
    targetOwner = fork.owner.login;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const ready = await gh.get(`/repos/${targetOwner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`).catch(() => null);
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  const { data: baseRef } = await gh.get(`/repos/${targetOwner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
  const newBranch = `skyforge/security-fix-${finding.rule}-${Date.now().toString(36)}`;
  await gh.post(`/repos/${targetOwner}/${repo}/git/refs`, { ref: `refs/heads/${newBranch}`, sha: baseRef.object.sha });
  const { data: forkFile } = await gh.get(`/repos/${targetOwner}/${repo}/contents/${encodePath(finding.path)}`, { params: { ref: newBranch } });
  const title = `Security: ${finding.title}`.slice(0, 120);
  await gh.put(`/repos/${targetOwner}/${repo}/contents/${encodePath(finding.path)}`, {
    message: `${title}\n\n${fix.summary}`,
    content: Buffer.from(fix.content).toString("base64"),
    sha: forkFile.sha,
    branch: newBranch,
  });

  const body = [
    `**Issue:** ${finding.title} (\`${finding.location}\`)`,
    "",
    finding.detail || "",
    "",
    `**Fix:** ${fix.summary}`,
    fix.envVars.length ? `\n**Before deploying:** set ${fix.envVars.map((name) => `\`${name}\``).join(", ")} on SkyForge's Environment page.` : "",
    "",
    "_Generated by SkyForge security scan. Review before merging._",
  ].join("\n");
  if (canPush) {
    const { data: pull } = await gh.post(`/repos/${owner}/${repo}/pulls`, { title, head: newBranch, base: baseBranch, body });
    return { url: pull.html_url, kind: "pull_request", branch: newBranch, summary: fix.summary, envVars: fix.envVars };
  }
  return {
    url: `https://github.com/${owner}/${repo}/compare/${encodeURIComponent(baseBranch)}...${targetOwner}:${encodeURIComponent(newBranch)}?expand=1`,
    kind: "fork_branch",
    branch: newBranch,
    summary: fix.summary,
    envVars: fix.envVars,
  };
}
