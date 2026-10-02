import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./commandRunner.js";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIM_SOURCE = path.join(SERVER_ROOT, "templates", "shim", "main.go");
const SHIM_BINARY = path.join(SERVER_ROOT, "generated", ".skyforge-shim", "skyforge-shim");
export const SHIM_CONTEXT_NAME = ".skyforge-shim";

let building = null;

/** Builds the static linux/amd64 port shim once (via Docker) and caches it under generated/. */
export async function ensurePortShim() {
  if (fsSync.existsSync(SHIM_BINARY)) return SHIM_BINARY;
  building ??= (async () => {
    const workDir = path.join(path.dirname(SHIM_BINARY), "build");
    await fs.mkdir(workDir, { recursive: true });
    await fs.copyFile(SHIM_SOURCE, path.join(workDir, "main.go"));
    await fs.writeFile(path.join(workDir, "Dockerfile"), [
      "FROM golang:1-alpine",
      "WORKDIR /src",
      "COPY main.go .",
      "RUN go mod init skyforge-shim && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags='-s -w' -o /skyforge-shim .",
      "",
    ].join("\n"));
    const image = "skyforge-port-shim:build";
    await runCommand("docker", ["build", "--platform", "linux/amd64", "-t", image, workDir], { timeout: 600_000 });
    const container = `skyforge-shim-extract-${Date.now()}`;
    try {
      await runCommand("docker", ["create", "--name", container, image], { timeout: 60_000 });
      await runCommand("docker", ["cp", `${container}:/skyforge-shim`, `${SHIM_BINARY}.tmp`], { timeout: 60_000 });
      await fs.rename(`${SHIM_BINARY}.tmp`, SHIM_BINARY);
    } finally {
      await runCommand("docker", ["rm", "-f", container], { timeout: 60_000 }).catch(() => {});
      await fs.rm(workDir, { recursive: true, force: true });
    }
    return SHIM_BINARY;
  })().finally(() => {
    building = null;
  });
  return building;
}

/**
 * Rewrites a generated Dockerfile so its final CMD runs under the shim.
 * Only exec-form (JSON array) CMDs are wrapped; anything else is returned unchanged.
 */
export function wrapDockerfileWithShim(dockerfile, port) {
  const lines = dockerfile.split("\n");
  const cmdIndex = lines.map((line) => /^\s*CMD\s+\[/i.test(line)).lastIndexOf(true);
  if (cmdIndex < 0 || !Number.isInteger(Number(port))) return dockerfile;
  let command;
  try {
    command = JSON.parse(lines[cmdIndex].replace(/^\s*CMD\s+/i, ""));
  } catch {
    return dockerfile;
  }
  if (!Array.isArray(command) || !command.length) return dockerfile;
  lines.splice(cmdIndex, 1,
    `COPY --chmod=755 ${SHIM_CONTEXT_NAME} /usr/local/bin/skyforge-shim`,
    `CMD ${JSON.stringify(["/usr/local/bin/skyforge-shim", String(port), ...command])}`);
  return lines.join("\n");
}
