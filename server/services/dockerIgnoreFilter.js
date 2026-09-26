import fs from "node:fs";
import path from "node:path";

function normalizeEntryPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function globExpression(pattern) {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return expression;
}

function patternMatches(pattern, relativePath) {
  const cleanPattern = normalizeEntryPath(pattern.replace(/^!/, ""));
  if (!cleanPattern) return false;
  const directoryPattern = cleanPattern.endsWith("/");
  const value = directoryPattern ? cleanPattern.slice(0, -1) : cleanPattern;
  const hasSlash = value.includes("/");
  const body = globExpression(value);
  const matcher = hasSlash
    ? new RegExp(`^${body}(?:/.*)?$`)
    : new RegExp(`(?:^|/)${body}(?:/.*)?$`);
  return matcher.test(relativePath);
}

export function createDockerIgnoreFilter(sourceDir, requiredPaths = []) {
  const ignorePath = path.join(sourceDir, ".dockerignore");
  const patterns = [];
  if (fs.existsSync(ignorePath)) {
    for (const rawLine of fs.readFileSync(ignorePath, "utf-8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      patterns.push({ negated: line.startsWith("!"), value: line.replace(/^!/, "") });
    }
  }
  const required = new Set(requiredPaths.map(normalizeEntryPath).filter(Boolean));

  return (entryPath, entry) => {
    const relativePath = normalizeEntryPath(typeof entryPath === "string" ? entryPath : entry?.path);
    if (!relativePath || relativePath === ".") return true;
    if (required.has(relativePath)) return true;
    let ignored = false;
    for (const pattern of patterns) {
      if (patternMatches(pattern.value, relativePath)) ignored = !pattern.negated;
    }
    return !ignored;
  };
}
