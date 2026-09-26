import fs from "node:fs";
import path from "node:path";

export function packageJson(directory) {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf-8"));
  } catch {
    return null;
  }
}

export function findFrontendWorkspace(sourceDir) {
  const candidates = [sourceDir, "client", "frontend", "web", "ui", "app", "server", "backend", "api", "public", "src"];
  for (const relative of candidates) {
    const directory = path.isAbsolute(relative) ? relative : path.join(sourceDir, relative);
    if (!fs.existsSync(directory)) continue;
    const pkg = packageJson(directory);
    if (pkg?.scripts?.build) return { directory, type: "PACKAGE", pkg };
    if (fs.existsSync(path.join(directory, "index.html"))) return { directory, type: "STATIC" };
  }

  const queue = [{ directory: sourceDir, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (current.depth > 4) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || [".git", "node_modules", "dist", "build", "coverage"].includes(entry.name)) continue;
      const directory = path.join(current.directory, entry.name);
      const pkg = packageJson(directory);
      if (pkg?.scripts?.build) return { directory, type: "PACKAGE", pkg };
      if (fs.existsSync(path.join(directory, "index.html"))) return { directory, type: "STATIC" };
      queue.push({ directory, depth: current.depth + 1 });
    }
  }
  return null;
}
