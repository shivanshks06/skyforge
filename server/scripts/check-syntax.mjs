import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignored = new Set(["node_modules", "generated", ".git", ".agents", ".claude", ".windsurf"]);
const files = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(fullPath);
  }
}

walk(root);
const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) failures.push({ file, output: `${result.stdout || ""}${result.stderr || ""}`.trim() });
}
if (failures.length) {
  for (const failure of failures) console.error(`${failure.file}\n${failure.output}`);
  process.exit(1);
}
console.log(`Syntax checked ${files.length} server JavaScript files.`);
