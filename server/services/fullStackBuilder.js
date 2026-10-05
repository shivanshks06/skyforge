import fs from "node:fs";
import path from "node:path";

/**
 * Full-stack repositories that keep a browser frontend and an API in sibling folders
 * (client/ + server/, frontend/ + backend/, web/ + api/ ...) and run them separately in
 * development. SkyForge builds both into one container behind a small gateway:
 *
 *   frontend  a single-page app (Vite, CRA, Vue, Angular, Svelte ...) served as static files,
 *             or a server-rendered Nitro app (TanStack Start, Nuxt) run as a Node server;
 *   backend   a Node API (installed by SkyForge), or any API with its own Dockerfile
 *             (FastAPI, Django, Go ...), whose Dockerfile becomes the base of the image;
 *   gateway   on the public port: API paths and WebSockets go to the backend, everything
 *             else to the frontend.
 *
 * The browser talks to one origin, so relative API URLs ("/api", socket.io) work unchanged,
 * exactly as they did behind the dev-server proxy.
 */

const FRONTEND_DIRS = ["client", "frontend", "web", "ui", "webapp", "app"];
const BACKEND_DIRS = ["server", "backend", "api", "service"];
// Server-rendered frameworks that need their own runtime; Nitro-based ones are supported.
const UNSUPPORTED_SSR = ["next", "@sveltejs/kit", "@remix-run/node", "@remix-run/react", "astro", "gatsby"];
const NITRO_SSR = ["@tanstack/react-start", "@tanstack/solid-start", "nuxt", "nitro", "nitropack"];
const SPA_TOOLS = ["vite", "react-scripts", "@vue/cli-service", "@angular/core", "parcel", "webpack", "svelte", "preact", "solid-js"];
const ENTRY_FILES = ["server.js", "index.js", "app.js", "main.js", "src/server.js", "src/index.js", "src/app.js", "src/main.js", "dist/index.js", "dist/server.js"];
const NON_NODE_MANIFESTS = ["pyproject.toml", "requirements.txt", "Pipfile", "go.mod", "Gemfile", "composer.json", "pom.xml", "build.gradle", "Cargo.toml", "mix.exs"];
const DEFAULT_API_PREFIXES = ["/api", "/socket.io", "/graphql", "/ws", "/health", "/healthz", "/metrics", "/uploads", "/static/admin"];

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

function frontendIn(root, dir) {
  const base = path.join(root, dir);
  const pkg = readJson(path.join(base, "package.json"));
  if (!pkg?.scripts?.build) return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (UNSUPPORTED_SSR.some((name) => deps[name])) return null;
  const lock = ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"].find((file) => fs.existsSync(path.join(base, file))) || null;
  const ssr = NITRO_SSR.find((name) => deps[name]);
  if (ssr) return { dir, kind: "ssr", tool: ssr, lock };
  const tool = SPA_TOOLS.find((name) => deps[name]);
  const hasIndex = ["index.html", "public/index.html", "src/index.html"].some((file) => fs.existsSync(path.join(base, file)));
  if (!tool && !hasIndex) return null;
  return { dir, kind: "spa", tool: tool || "static build", lock };
}

function nodeBackendIn(root, dir) {
  const base = path.join(root, dir);
  const pkg = readJson(path.join(base, "package.json"));
  if (!pkg) return null;
  const entry = ENTRY_FILES.find((file) => fs.existsSync(path.join(base, file)));
  if (!pkg.scripts?.start && !entry && !pkg.main) return null;
  const deps = { ...pkg.dependencies };
  // A frontend-only package (vite app) in a "server"-named folder is not an API.
  if (!Object.keys(deps).some((name) => /^(express|fastify|koa|@nestjs\/core|hapi|@hapi\/hapi|hono|restify|socket\.io|apollo-server|@apollo\/server|ws|polka|micro)$/.test(name)) && !entry) return null;
  return { dir, kind: "node", pkg, entry, framework: ["express", "fastify", "koa", "@nestjs/core", "hono", "@hapi/hapi"].find((name) => deps[name]) || "node" };
}

/** A non-Node API that ships its own Dockerfile (FastAPI, Django, Go, Rails ...). */
function dockerBackendIn(root, dir) {
  const base = path.join(root, dir);
  if (!fs.existsSync(path.join(base, "Dockerfile")) || !NON_NODE_MANIFESTS.some((file) => fs.existsSync(path.join(base, file)))) return null;
  const manifest = NON_NODE_MANIFESTS.map((file) => readText(path.join(base, file))).join("\n").toLowerCase();
  const framework = ["fastapi", "django", "flask", "starlette", "litestar", "sanic"].find((name) => manifest.includes(name))
    || (fs.existsSync(path.join(base, "go.mod")) ? "go" : fs.existsSync(path.join(base, "Gemfile")) ? "ruby" : fs.existsSync(path.join(base, "composer.json")) ? "php" : fs.existsSync(path.join(base, "pom.xml")) || fs.existsSync(path.join(base, "build.gradle")) ? "java" : "service");
  return { dir, kind: "docker", framework };
}

/** Internal port of a Node API (from `process.env.PORT || 5000`, .env.example, or its Dockerfile). */
function nodeBackendPort(root, dir) {
  const base = path.join(root, dir);
  for (const text of [...ENTRY_FILES, "src/config/index.js", "src/config.js", "config.js"].map((file) => readText(path.join(base, file)).slice(0, 200_000))) {
    const match = text.match(/process\.env\.PORT\s*(?:\|\||\?\?)\s*["']?(\d{2,5})/) || text.match(/\.listen\(\s*(\d{4,5})\b/);
    if (match) return Number(match[1]);
  }
  for (const file of [".env.example", ".env.sample", ".env.template"]) {
    const match = readText(path.join(base, file)).match(/^\s*PORT\s*=\s*(\d{2,5})/m);
    if (match) return Number(match[1]);
  }
  const exposed = readText(path.join(base, "Dockerfile")).match(/^\s*EXPOSE\s+(\d{2,5})/im);
  return exposed ? Number(exposed[1]) : 5000;
}

/** Joins Dockerfile line continuations into whole instructions. */
function dockerInstructions(text) {
  const out = [];
  let current = "";
  for (const line of text.split(/\r?\n/)) {
    if (!current && /^\s*(#.*)?$/.test(line)) {
      out.push(line);
      continue;
    }
    current += (current ? "\n" : "") + line;
    if (!/\\\s*$/.test(line)) {
      out.push(current);
      current = "";
    }
  }
  if (current) out.push(current);
  return out;
}

const parseCommand = (value) => {
  const text = String(value || "").trim();
  if (!text) return null;
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) && parsed.length ? parsed : null;
    } catch {
      return null;
    }
  }
  return ["sh", "-c", text];
};

/**
 * The backend's own Dockerfile, rewritten for a build context at the repository root:
 * COPY/ADD sources gain the folder prefix, stage names cannot clash with SkyForge's, and the
 * final CMD/ENTRYPOINT become the command the gateway runs.
 */
export function inlineBackendDockerfile(text, dir) {
  const lines = dockerInstructions(text);
  let command = null;
  let entrypoint = null;
  let workdir = "/";
  let user = null;
  let port = null;
  let alpine = false;
  const kept = [];
  for (const raw of lines) {
    const match = raw.match(/^\s*([A-Za-z]+)\s+([\s\S]*)$/);
    if (!match) {
      kept.push(raw);
      continue;
    }
    const instruction = match[1].toUpperCase();
    const rest = match[2];
    if (instruction === "FROM") {
      alpine = /alpine/i.test(rest);
      workdir = "/";
      user = null;
      command = null;
      entrypoint = null;
      kept.push(raw.replace(/\s+AS\s+(frontend|backend|skyforge\w*)\s*$/i, (_whole, name) => ` AS backend_${name}`));
      continue;
    }
    if (instruction === "CMD") {
      command = parseCommand(rest);
      continue;
    }
    if (instruction === "ENTRYPOINT") {
      entrypoint = parseCommand(rest);
      continue;
    }
    if (instruction === "WORKDIR") workdir = path.posix.resolve(workdir, rest.trim().replace(/^["']|["']$/g, ""));
    if (instruction === "USER") user = rest.trim();
    if (instruction === "EXPOSE") port = Number(rest.match(/\d{2,5}/)?.[0]) || port;
    if ((instruction === "COPY" || instruction === "ADD") && !/--from=/i.test(rest)) {
      kept.push(rewriteCopy(instruction, rest, dir));
      continue;
    }
    kept.push(raw);
  }
  // Shell-form ENTRYPOINT ignores CMD; exec-form ENTRYPOINT takes CMD as arguments.
  const finalCommand = entrypoint
    ? (entrypoint[0] === "sh" && entrypoint[1] === "-c" ? entrypoint : [...entrypoint, ...(command || [])])
    : command;
  return { text: kept.join("\n"), command: finalCommand, workdir, user, port, alpine };
}

function rewriteCopy(instruction, rest, dir) {
  const prefix = (source) => (/^(https?:|git@)/.test(source) ? source : path.posix.join(dir, source.replace(/^\.\/?/, "") || "."));
  const flags = [];
  let body = rest.trim();
  while (body.startsWith("--")) {
    const [flag, ...after] = body.split(/\s+/);
    flags.push(flag);
    body = after.join(" ");
  }
  if (body.startsWith("[")) {
    try {
      const parts = JSON.parse(body);
      return `${instruction} ${[...flags, JSON.stringify([...parts.slice(0, -1).map(prefix), parts.at(-1)])].join(" ")}`;
    } catch {}
  }
  const parts = body.split(/\s+/).filter(Boolean);
  return `${instruction} ${[...flags, ...parts.slice(0, -1).map(prefix), parts.at(-1)].join(" ")}`;
}

/** First path segments the API serves, from route declarations in its source. */
function backendPrefixes(root, dir) {
  const found = new Set();
  const walk = (folder, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!/^(node_modules|\.venv|venv|tests?|__pycache__|migrations|\.git|dist|build)$/.test(entry.name)) walk(path.join(folder, entry.name), depth + 1);
        continue;
      }
      if (!/\.(py|go|rb|php|java|kt|js|ts)$/.test(entry.name)) continue;
      const text = readText(path.join(folder, entry.name)).slice(0, 300_000);
      // Only top-level mounts: sub-router paths (mounted under /api) and outgoing HTTP calls to
      // other services would otherwise steal frontend pages such as /services or /chat.
      const patterns = [
        /\bprefix\s*=\s*["'](\/[A-Za-z0-9_.-]+)/g, // FastAPI APIRouter(prefix=) / include_router(prefix=)
        /@app\.(?:get|post|put|patch|delete|api_route|websocket|route)\(\s*["'](\/[A-Za-z0-9_.-]+)/g, // Flask / FastAPI app routes
        /\b(?:app|server)\.(?:use|get|post|put|patch|delete|all)\(\s*["'`](\/[A-Za-z0-9_.-]+)/g, // Express / Koa app-level
        /\b(?:r|router|e|app)\.(?:Group|Mount|Route)\(\s*"(\/[A-Za-z0-9_.-]+)/g, // Go routers
      ];
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) found.add(`/${match[1].replace(/^\//, "")}`);
      }
    }
  };
  walk(path.join(root, dir), 0);
  return [...found].filter((prefix) => prefix.length > 1 && prefix !== "/index.html");
}

/** { frontend, backend, nodeMajor, summary } when the repository is a frontend + API pair, otherwise null. */
export function detectFullStack(sourceDir) {
  const rootPkg = readJson(path.join(sourceDir, "package.json"));
  // A root package that is itself an app (has its own server or framework) is not a split layout.
  if (rootPkg && Object.keys({ ...rootPkg.dependencies }).some((name) => /^(express|fastify|koa|next|react|vue|@nestjs\/core|vite)$/.test(name))) return null;
  const frontend = FRONTEND_DIRS.map((dir) => frontendIn(sourceDir, dir)).find(Boolean);
  if (!frontend) return null;
  const candidates = BACKEND_DIRS.filter((dir) => dir !== frontend.dir);
  const backend = candidates.map((dir) => nodeBackendIn(sourceDir, dir)).find(Boolean) || candidates.map((dir) => dockerBackendIn(sourceDir, dir)).find(Boolean);
  if (!backend) return null;

  let details;
  if (backend.kind === "node") {
    const docker = readText(path.join(sourceDir, backend.dir, "Dockerfile"));
    const command = docker ? inlineBackendDockerfile(docker, backend.dir).command : null;
    const engines = String(backend.pkg.engines?.node || "").match(/(\d{2})/);
    const nodeMajor = Number(docker.match(/^\s*FROM\s+node:(\d+)/im)?.[1]) || (engines ? Number(engines[1]) : 22);
    details = {
      port: nodeBackendPort(sourceDir, backend.dir),
      command: command || (backend.pkg.scripts?.start ? ["npm", "start"] : ["node", backend.entry || backend.pkg.main]),
      nodeMajor: Math.max(18, Math.min(nodeMajor, 24)),
    };
  } else {
    const inlined = inlineBackendDockerfile(readText(path.join(sourceDir, backend.dir, "Dockerfile")), backend.dir);
    if (!inlined.command) return null;
    details = { port: inlined.port || 8000, command: inlined.command, nodeMajor: 22, dockerfile: inlined };
  }
  const prefixes = [...new Set([...DEFAULT_API_PREFIXES, ...backendPrefixes(sourceDir, backend.dir)])];
  return {
    frontend,
    backend: { dir: backend.dir, kind: backend.kind, framework: backend.framework, port: details.port, command: details.command, prefixes, dockerfile: details.dockerfile || null },
    nodeMajor: details.nodeMajor,
    summary: `full-stack app: ${frontend.kind === "ssr" ? `server-rendered ${frontend.tool}` : frontend.tool} frontend in ${frontend.dir}/ + ${backend.framework} API in ${backend.dir}/`,
  };
}

const installScript = [
  "if [ -f bun.lock ] || [ -f bun.lockb ]; then npm install -g bun >/dev/null && (bun install --frozen-lockfile || bun install);",
  "elif [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile;",
  "elif [ -f yarn.lock ]; then corepack enable && yarn install --frozen-lockfile;",
  "elif [ -f package-lock.json ]; then npm ci || npm install;",
  "else npm install; fi",
].join(" ");

const productionInstallScript = [
  "if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile --prod;",
  "elif [ -f yarn.lock ]; then corepack enable && yarn install --frozen-lockfile --production;",
  "elif [ -f package-lock.json ]; then npm ci --omit=dev;",
  "else npm install --omit=dev; fi",
].join(" ");

/** Public port: 80, or 8080 when the backend image runs as a non-root user (which cannot bind 80). */
export function fullStackPublicPort(stack) {
  const user = stack.backend.dockerfile?.user;
  return user && !/^(root|0)(:.*)?$/.test(user) ? 8080 : 80;
}

export function generateFullStackDockerfile(stack, { publicPort = fullStackPublicPort(stack), publicEnvKeys = [] } = {}) {
  const { frontend, backend, nodeMajor } = stack;
  const buildArgs = publicEnvKeys.flatMap((key) => [`ARG ${key}`, `ENV ${key}=$${key}`]);
  const frontendStage = [
    `FROM node:${nodeMajor}-bookworm-slim AS skyforge_frontend`,
    "WORKDIR /build",
    `COPY ${frontend.dir}/ ./`,
    "RUN rm -rf node_modules .output dist build",
    `RUN ${installScript}`,
    ...buildArgs,
    ...(frontend.kind === "ssr"
      ? [
        // Nitro builds for the platform in NITRO_PRESET; a Node server is what runs in the container.
        "ENV NITRO_PRESET=node-server",
        "RUN npm run build",
        "RUN test -f .output/server/index.mjs || (echo 'The frontend build did not produce .output/server/index.mjs' && exit 1); mkdir -p /site && cp -r .output/. /site/",
      ]
      : [
        "RUN npm run build || NODE_OPTIONS=--openssl-legacy-provider npm run build",
        // Build output lives in dist/, build/ or out/ (Angular nests it one or two folders deeper).
        "RUN set -e; index=$(find dist build out -maxdepth 3 -name index.html 2>/dev/null | awk '{ print length, $0 }' | sort -n | head -1 | cut -d' ' -f2-); \\",
        "    if [ -z \"$index\" ]; then echo 'The frontend build produced no index.html (looked in dist/, build/, out/)'; exit 1; fi; \\",
        "    mkdir -p /site && cp -r \"$(dirname \"$index\")\"/. /site/",
      ]),
    "",
  ];
  const gatewayEnv = (cwd) => [
    `ENV SKYFORGE_BACKEND_PORT=${backend.port}`,
    // "\$" keeps Docker from expanding ${PORT:-8000} at build time; the shell expands it at run time.
    `ENV SKYFORGE_BACKEND_COMMAND=${JSON.stringify(JSON.stringify(backend.command)).replace(/\$/g, "\\$")}`,
    `ENV SKYFORGE_BACKEND_CWD=${JSON.stringify(cwd)}`,
    `ENV SKYFORGE_BACKEND_PREFIXES=${JSON.stringify(backend.prefixes.join(","))}`,
    `ENV SKYFORGE_FRONTEND_MODE=${frontend.kind}`,
    "ENV SKYFORGE_SITE=/skyforge/frontend",
    `ENV PORT=${publicPort}`,
    `EXPOSE ${publicPort}`,
  ];

  if (backend.kind === "docker") {
    const inlined = backend.dockerfile;
    return [
      "# Generated by SkyForge for a full-stack repository:",
      `# ${stack.summary}`,
      ...frontendStage,
      `# ---- ${backend.dir}/Dockerfile (paths adjusted for the repository root) ----`,
      inlined.text,
      `# ---- SkyForge: add the frontend and the gateway ----`,
      ...(inlined.user ? ["USER root"] : []),
      `COPY --from=node:${nodeMajor}-${inlined.alpine ? "alpine" : "bookworm-slim"} /usr/local/bin/node /usr/local/bin/node`,
      "COPY --from=skyforge_frontend /site /skyforge/frontend",
      "COPY .skyforge-gateway.mjs /skyforge/gateway.mjs",
      ...gatewayEnv(inlined.workdir),
      ...(inlined.user ? [`USER ${inlined.user}`] : []),
      "ENTRYPOINT []",
      "CMD [\"node\", \"/skyforge/gateway.mjs\"]",
      "",
    ].join("\n");
  }

  return [
    "# Generated by SkyForge for a full-stack repository:",
    `# ${stack.summary}`,
    ...frontendStage,
    `FROM node:${nodeMajor}-alpine AS skyforge_backend`,
    "WORKDIR /build",
    `COPY ${backend.dir}/package*.json ${backend.dir}/yarn.lock* ${backend.dir}/pnpm-lock.yaml* ./`,
    // Native modules (bcrypt, sharp ...) sometimes need a compiler on Alpine.
    `RUN (${productionInstallScript}) || (apk add --no-cache python3 make g++ && ${productionInstallScript})`,
    `COPY ${backend.dir}/ ./`,
    "",
    `FROM node:${nodeMajor}-alpine`,
    "RUN apk add --no-cache tini",
    "WORKDIR /app",
    "ENV NODE_ENV=production",
    "COPY --from=skyforge_backend /build ./backend",
    "COPY --from=skyforge_frontend /site /skyforge/frontend",
    "COPY .skyforge-gateway.mjs /skyforge/gateway.mjs",
    ...gatewayEnv("/app/backend"),
    "ENTRYPOINT [\"/sbin/tini\", \"--\"]",
    "CMD [\"node\", \"/skyforge/gateway.mjs\"]",
    "",
  ].join("\n");
}

/** The gateway: API paths and WebSockets to the backend, everything else to the frontend. */
export const GATEWAY_SCRIPT = `import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const PUBLIC_PORT = Number(process.env.PORT || 80);
const BACKEND_PORT = Number(process.env.SKYFORGE_BACKEND_PORT || 5000);
const FRONTEND_PORT = 3999;
const COMMAND = JSON.parse(process.env.SKYFORGE_BACKEND_COMMAND || '["npm","start"]');
const MODE = process.env.SKYFORGE_FRONTEND_MODE || "spa";
const SITE = process.env.SKYFORGE_SITE || "/skyforge/frontend";
const PREFIXES = String(process.env.SKYFORGE_BACKEND_PREFIXES || "/api").split(",").filter(Boolean);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".txt": "text/plain", ".map": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm", ".onnx": "application/octet-stream" };

// Child processes: the API on its internal port, and (server-rendered frontends) the page server.
// If either stops, the container stops, so AWS restarts it.
function start(name, command, args, options) {
  const child = spawn(command, args, { ...options, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    console.error(\`[gateway] \${name} exited (\${signal || code}); stopping the container.\`);
    process.exit(typeof code === "number" && code !== 0 ? code : 1);
  });
  return child;
}
const children = [start("API", COMMAND[0], COMMAND.slice(1), { cwd: process.env.SKYFORGE_BACKEND_CWD || "/", env: { ...process.env, PORT: String(BACKEND_PORT) } })];
if (MODE === "ssr") {
  children.push(start("Frontend server", process.execPath, [path.join(SITE, "server/index.mjs")], { cwd: SITE, env: { ...process.env, PORT: String(FRONTEND_PORT), NITRO_PORT: String(FRONTEND_PORT), HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1" } }));
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { for (const child of children) child.kill(signal); setTimeout(() => process.exit(0), 8000).unref(); });

function staticFile(urlPath) {
  try {
    const decoded = decodeURIComponent(urlPath);
    const file = path.join(SITE, path.normalize(decoded));
    if (!file.startsWith(SITE)) return null;
    const stat = fs.statSync(file);
    if (stat.isFile()) return file;
    if (stat.isDirectory() && fs.existsSync(path.join(file, "index.html"))) return path.join(file, "index.html");
  } catch {}
  return null;
}

function sendFile(res, file) {
  const ext = path.extname(file).toLowerCase();
  const immutable = /\\/assets\\/|\\.[0-9a-f]{8,}\\./i.test(file);
  res.writeHead(200, {
    "Content-Type": TYPES[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  fs.createReadStream(file).pipe(res);
}

function proxy(req, res, port) {
  const upstream = http.request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-for": req.headers["x-forwarded-for"] || req.socket.remoteAddress, "x-forwarded-proto": req.headers["x-forwarded-proto"] || "http", "x-forwarded-host": req.headers["x-forwarded-host"] || req.headers.host || "" } }, (answer) => {
    res.writeHead(answer.statusCode || 502, answer.headers);
    answer.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "The app is starting or not reachable yet." }));
  });
  req.pipe(upstream);
}

const isApi = (pathname) => PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"));

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://x").pathname;
  if (isApi(pathname)) return proxy(req, res, BACKEND_PORT);
  if (MODE === "ssr") return proxy(req, res, FRONTEND_PORT);
  if (req.method === "GET" || req.method === "HEAD") {
    const file = staticFile(pathname);
    if (file) return sendFile(res, file);
    // Client-side routes (/dashboard, /settings ...) load the app shell.
    if (/text\\/html/.test(req.headers.accept || "") || pathname === "/") return sendFile(res, path.join(SITE, "index.html"));
  }
  proxy(req, res, BACKEND_PORT);
});

// WebSockets (socket.io, ws) go to whichever process owns the path.
server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url, "http://x").pathname;
  const port = isApi(pathname) || MODE !== "ssr" ? BACKEND_PORT : FRONTEND_PORT;
  const upstream = net.connect(port, "127.0.0.1", () => {
    upstream.write(\`\${req.method} \${req.url} HTTP/\${req.httpVersion}\\r\\n\` + Object.entries(req.headers).map(([key, value]) => \`\${key}: \${value}\`).join("\\r\\n") + "\\r\\n\\r\\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(socket).pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(PUBLIC_PORT, "0.0.0.0", () => console.log(\`[gateway] :\${PUBLIC_PORT} → frontend (\${MODE}) + API :\${BACKEND_PORT} (\${COMMAND.join(" ")}); API paths: \${PREFIXES.join(" ")}\`));
`;

function frontendSourceText(sourceDir, stack) {
  const root = path.join(sourceDir, stack.frontend.dir, "src");
  const chunks = [];
  const walk = (dir, depth) => {
    if (depth > 6 || chunks.length > 800) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full, depth + 1);
      } else if (/\.(jsx?|tsx?|vue|svelte|mjs)$/.test(entry.name)) {
        chunks.push({ file: path.relative(sourceDir, full).split(path.sep).join("/"), text: readText(full).slice(0, 100_000) });
      }
    }
  };
  walk(root, 0);
  return chunks;
}

/**
 * Build-time values for a single-origin deployment, for variables the owner did not set:
 *  - socket/WebSocket URLs default to "/" (this site);
 *  - API base URLs default to "" (same origin), which code like `VITE_API_URL ?? "http://localhost:8000"`
 *    turns into relative requests that the gateway forwards to the API.
 * Their usual fallback, http://localhost:<port>, points at the visitor's own computer in production.
 * Returns { defaults, localhostFallbacks } (the latter for a warning).
 */
export function frontendBuildDefaults(sourceDir, stack, setKeys = []) {
  const files = frontendSourceText(sourceDir, stack);
  const names = new Set();
  for (const { text } of files) {
    for (const match of text.matchAll(/(?:import\.meta\.env|process\.env)(?:\.|\[\s*["'])((?:VITE|REACT_APP|VUE_APP|PUBLIC|NUXT_PUBLIC)_\w+)/g)) names.add(match[1]);
  }
  const defaults = {};
  for (const name of names) {
    if (setKeys.includes(name)) continue;
    if (/SOCKET|(^|_)WS(_|$)|WEBSOCKET/.test(name)) defaults[name] = "/";
    else if (/(API|BACKEND|SERVER)(_BASE)?_(URL|URI|ORIGIN|HOST)$|(^|_)API_BASE$/.test(name)) defaults[name] = "";
  }
  const localhostFallbacks = files
    .filter(({ text }) => /(?:\|\||\?\?)\s*["'`]https?:\/\/(?:localhost|127\.0\.0\.1):\d+/.test(text))
    .map(({ file }) => file)
    .slice(0, 10);
  return { defaults, localhostFallbacks };
}

export function writeFullStackWorkspace(sourceDir, stack, options) {
  const dockerfilePath = path.join(sourceDir, ".skyforge.fullstack.Dockerfile");
  fs.writeFileSync(dockerfilePath, generateFullStackDockerfile(stack, options));
  fs.writeFileSync(path.join(sourceDir, ".skyforge-gateway.mjs"), GATEWAY_SCRIPT);
  return dockerfilePath;
}
