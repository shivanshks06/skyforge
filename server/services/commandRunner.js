import { spawn } from "node:child_process";

const MAX_LINE_LENGTH = 16_000;

function emitLine(onLine, stream, line) {
  const clean = String(line || "").replace(/[\r\n]+/g, "").trim();
  if (clean) onLine?.(clean.slice(0, MAX_LINE_LENGTH), stream);
}

function appendOutputLine(buffer, text, stream, onLine) {
  const combined = `${buffer}${text}`;
  const lines = combined.split(/\r?\n/);
  const pending = lines.pop() || "";
  for (const line of lines) emitLine(onLine, stream, line);
  if (pending.length > MAX_LINE_LENGTH) {
    emitLine(onLine, stream, pending.slice(-MAX_LINE_LENGTH));
    return "";
  }
  return pending;
}

function terminateChild(child, force = false) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(child.pid), "/T"];
    if (force) args.push("/F");
    try {
      const killer = spawn("taskkill", args, { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => {
        try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {}
      });
    } catch {
      try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {}
    }
    return;
  }
  try {
    if (child.spawnargs && child.pid) process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
    else child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {}
  }
}

export function runCommand(command, args = [], options = {}) {
  const {
    cwd,
    env = process.env,
    onLine,
    timeout = 120_000,
    input,
    maxOutput = 200_000,
  } = options;

  // On Windows, npm/npx are .cmd scripts and require shell: true. On POSIX,
  // detached children give us a process group that can be terminated as a unit.
  const needsShell = process.platform === "win32" && /^(?:npm|npx|yarn|pnpm)$/i.test(command);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: needsShell,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    let settled = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let forceKillTimer;
    const timer = setTimeout(() => {
      terminateChild(child, false);
      forceKillTimer = setTimeout(() => terminateChild(child, true), 5_000);
      finish(new Error(`${command} timed out after ${timeout}ms`), undefined, true);
    }, timeout);

    const finish = (error, result, preserveForceKill = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!preserveForceKill) clearTimeout(forceKillTimer);
      if (error) reject(error);
      else resolve(result);
    };

    const collect = (chunk, stream) => {
      const text = chunk.toString();
      output = `${output}${text}`.slice(-maxOutput);
      if (stream === "stdout") stdoutBuffer = appendOutputLine(stdoutBuffer, text, stream, onLine);
      else stderrBuffer = appendOutputLine(stderrBuffer, text, stream, onLine);
    };

    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(chunk, "stderr"));
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      clearTimeout(forceKillTimer);
      emitLine(onLine, "stdout", stdoutBuffer);
      emitLine(onLine, "stderr", stderrBuffer);
      if (code === 0) {
        finish(null, { code, output });
      } else {
        if (/failed to connect to the docker API|daemon is running|dockerDesktopLinuxEngine/i.test(output)) {
          finish(new Error("Docker Desktop / daemon is not running. Please start Docker Desktop to build and push container images."));
        } else {
          finish(new Error(`${command} exited with ${code ?? signal}: ${output.slice(-1000)}`));
        }
      }
    });

    if (input && typeof input.pipe === "function") {
      input.on("error", (error) => finish(error));
      input.pipe(child.stdin);
    } else if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
