#!/usr/bin/env node
// One command for the whole local stack.
//   npm start        → Redis (Docker) + database check + migrations + API + worker + web app
//   npm stop         → stops all of them (PostgreSQL, a system service, is left running)
//   npm run status   → shows what is running
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = path.join(ROOT, ".skyforge");
const LOG_DIR = path.join(STATE_DIR, "logs");
const PID_FILE = path.join(STATE_DIR, "pids.json");
const REDIS_CONTAINER = "skyforge-redis";
const isWindows = process.platform === "win32";

const PROCESSES = [
  { name: "api", label: "API", cwd: "server", args: ["--dns-result-order=ipv4first", "server.js"], port: 5000, match: /--dns-result-order=ipv4first\s+server\.js/ },
  { name: "worker", label: "Worker", cwd: "server", args: ["--dns-result-order=ipv4first", "workers/index.js"], match: /--dns-result-order=ipv4first\s+workers\/index\.js/ },
  { name: "client", label: "Web app", cwd: "client", args: ["node_modules/vite/bin/vite.js", "--port", "5173", "--strictPort"], port: 5173, match: /vite\/bin\/vite\.js/, inProject: true },
];

const green = (text) => `\x1b[32m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;
const dim = (text) => `\x1b[2m${text}\x1b[0m`;
const step = (text) => console.log(`${dim("•")} ${text}`);
const ok = (text) => console.log(`${green("✓")} ${text}`);
const fail = (text) => console.log(`${red("✗")} ${text}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, windowsHide: true, ...options });
  return { ok: result.status === 0, out: `${result.stdout || ""}${result.stderr || ""}`.trim() };
}

// "localhost" can be IPv4 or IPv6 depending on the program (Vite binds ::1 on Windows).
async function portOpen(port) {
  return (await portOpenOn(port, "127.0.0.1")) || portOpenOn(port, "::1");
}

function portOpenOn(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(1000);
  }
  return false;
}

function readPids() {
  try {
    return JSON.parse(fs.readFileSync(PID_FILE, "utf8"));
  } catch {
    return {};
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Node processes belonging to this project, found by command line (covers ones started by hand). */
function projectNodeProcesses() {
  if (isWindows) {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }";
    const result = run("powershell.exe", ["-NoProfile", "-Command", script]);
    return result.out.split(/\r?\n/).map((line) => {
      const [pid, ...rest] = line.split("\t");
      return { pid: Number(pid), cmd: rest.join("\t") };
    }).filter((item) => item.pid && item.cmd);
  }
  const result = run("ps", ["-eo", "pid=,args="]);
  return result.out.split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), cmd: match[2] } : null;
  }).filter((item) => item && /node/.test(item.cmd));
}

function findRunning(processDef) {
  const root = ROOT.toLowerCase().replaceAll("\\", "/");
  return projectNodeProcesses()
    .filter((item) => {
      const cmd = item.cmd.toLowerCase().replaceAll("\\", "/");
      return processDef.match.test(cmd) && (!processDef.inProject || cmd.includes(root));
    })
    .map((item) => item.pid)
    .filter((pid) => pid !== process.pid);
}

function killTree(pid) {
  if (!alive(pid)) return;
  if (isWindows) run("taskkill", ["/PID", String(pid), "/T", "/F"]);
  else {
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
  }
}

// ---------------------------------------------------------------- start

/** A real Redis answer, not just an open port (Docker's port forwarder accepts connections even when the container is down). */
function redisPing() {
  return new Promise((resolve) => {
    const socket = net.connect({ port: 6379, host: "127.0.0.1" });
    let reply = "";
    socket.setTimeout(1500);
    socket.once("connect", () => socket.write("PING\r\n"));
    socket.on("data", (chunk) => {
      reply += chunk;
      if (/PONG|NOAUTH/.test(reply)) { socket.destroy(); resolve(true); }
    });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
    socket.once("close", () => resolve(/PONG|NOAUTH/.test(reply)));
  });
}

async function ensureRedis() {
  if (await redisPing()) return ok("Redis is running (port 6379)");
  const docker = run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (!docker.ok) {
    fail("Redis is not running and Docker is not available. Start Docker Desktop, then run npm start again.");
    process.exit(1);
  }
  const exists = run("docker", ["ps", "-a", "--filter", `name=^/${REDIS_CONTAINER}$`, "--format", "{{.Names}}"]).out === REDIS_CONTAINER;
  step(exists ? "Starting Redis container..." : "Creating Redis container...");
  const result = exists
    ? run("docker", ["start", REDIS_CONTAINER])
    : run("docker", ["run", "-d", "--name", REDIS_CONTAINER, "-p", "6379:6379", "--restart", "unless-stopped", "redis:7-alpine"]);
  if (!result.ok || !(await waitFor(redisPing, 30_000))) {
    fail(`Redis did not start: ${result.out.slice(0, 200)}`);
    process.exit(1);
  }
  ok("Redis started");
}

async function ensurePostgres() {
  if (await portOpen(5432)) return ok("PostgreSQL is running (port 5432)");
  if (isWindows) {
    const services = run("powershell.exe", ["-NoProfile", "-Command", "Get-Service postgresql* | Select-Object -ExpandProperty Name"]).out.split(/\r?\n/).filter(Boolean);
    for (const service of services) {
      step(`Starting Windows service ${service}...`);
      run("powershell.exe", ["-NoProfile", "-Command", `Start-Service ${service}`]);
    }
    if (await waitFor(() => portOpen(5432), 20_000)) return ok("PostgreSQL started");
    fail(`PostgreSQL is not running and could not be started${services.length ? " (starting a service may need an Administrator terminal)" : ""}.`);
  } else {
    fail("PostgreSQL is not running on port 5432. Start it (e.g. sudo systemctl start postgresql).");
  }
  process.exit(1);
}

function migrate() {
  step("Applying database migrations...");
  const result = run("npx prisma migrate deploy", [], { cwd: path.join(ROOT, "server"), shell: true });
  if (!result.ok) {
    fail(`Migrations failed:\n${result.out.slice(-800)}`);
    process.exit(1);
  }
  ok("Database is up to date");
}

function launch(processDef) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${processDef.name}.log`);
  const log = fs.openSync(logPath, "a");
  fs.writeSync(log, `\n===== ${new Date().toISOString()} starting ${processDef.label} =====\n`);
  const child = spawn(process.execPath, processDef.args, {
    cwd: path.join(ROOT, processDef.cwd),
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  child.unref();
  return child.pid;
}

async function start() {
  console.log("\nStarting SkyForge...\n");
  for (const dir of ["server/node_modules", "client/node_modules"]) {
    if (!fs.existsSync(path.join(ROOT, dir))) {
      fail(`${dir} is missing. Run: npm run install:all`);
      process.exit(1);
    }
  }
  if (!fs.existsSync(path.join(ROOT, "server/.env"))) {
    fail("server/.env is missing. Copy server/.env.example to server/.env and fill it in.");
    process.exit(1);
  }
  await ensureRedis();
  await ensurePostgres();
  migrate();

  const pids = readPids();
  for (const processDef of PROCESSES) {
    const existing = [pids[processDef.name], ...findRunning(processDef)].filter(alive);
    if (existing.length) {
      ok(`${processDef.label} is already running (pid ${existing[0]})`);
      pids[processDef.name] = existing[0];
      continue;
    }
    if (processDef.port && (await portOpen(processDef.port))) {
      fail(`Port ${processDef.port} is used by another program; ${processDef.label} cannot start. Free it or run npm stop.`);
      continue;
    }
    pids[processDef.name] = launch(processDef);
    step(`${processDef.label} starting (pid ${pids[processDef.name]})...`);
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));

  const apiReady = await waitFor(async () => {
    try {
      const response = await fetch("http://localhost:5000/readyz");
      const body = await response.json();
      return body.status === "ready" && body.checks?.worker;
    } catch {
      return false;
    }
  }, 60_000);
  const clientReady = await waitFor(() => portOpen(5173), 60_000);

  console.log("");
  apiReady ? ok("API and worker are ready      http://localhost:5000") : fail(`API/worker not ready yet; see ${path.relative(ROOT, LOG_DIR)}/api.log and worker.log`);
  clientReady ? ok("Web app is ready              http://localhost:5173") : fail(`Web app not ready yet; see ${path.relative(ROOT, LOG_DIR)}/client.log`);
  console.log(`\nLogs: ${path.relative(ROOT, LOG_DIR)}/   ·   Stop everything: npm stop\n`);
  if (!apiReady || !clientReady) process.exitCode = 1;
}

// ---------------------------------------------------------------- stop

async function stop() {
  console.log("\nStopping SkyForge...\n");
  const pids = readPids();
  for (const processDef of PROCESSES) {
    const targets = [...new Set([pids[processDef.name], ...findRunning(processDef)].filter(alive))];
    if (!targets.length) {
      console.log(`${dim("-")} ${processDef.label} was not running`);
      continue;
    }
    for (const pid of targets) killTree(pid);
    const stopped = await waitFor(async () => targets.every((pid) => !alive(pid)), 10_000);
    stopped ? ok(`${processDef.label} stopped`) : fail(`${processDef.label} (pid ${targets.join(", ")}) did not stop`);
  }
  fs.rmSync(PID_FILE, { force: true });

  if (process.argv.includes("--keep-redis")) {
    console.log(`${dim("-")} Redis left running (--keep-redis)`);
  } else {
    const result = run("docker", ["stop", REDIS_CONTAINER]);
    result.ok ? ok("Redis stopped") : console.log(`${dim("-")} Redis was not running`);
  }
  console.log(`${dim("-")} PostgreSQL left running (system service; your data is safe)\n`);
}

// ---------------------------------------------------------------- status

async function status() {
  const pids = readPids();
  console.log("");
  const line = (up, label, detail) => console.log(`${up ? green("● running") : red("○ stopped")}  ${label.padEnd(12)} ${dim(detail)}`);
  line(await portOpen(5432), "PostgreSQL", "port 5432");
  line(await redisPing(), "Redis", "port 6379");
  for (const processDef of PROCESSES) {
    const running = [pids[processDef.name], ...findRunning(processDef)].filter(alive);
    line(running.length > 0, processDef.label, running.length ? `pid ${running[0]}${processDef.port ? `, http://localhost:${processDef.port}` : ""}` : "");
  }
  console.log("");
}

const command = process.argv[2];
const actions = { start, stop, status, restart: async () => { await stop(); await start(); } };
if (!actions[command]) {
  console.log("Usage: node scripts/skyforge.mjs <start|stop|restart|status> [--keep-redis]");
  process.exit(1);
}
await actions[command]();
