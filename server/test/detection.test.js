import test from "node:test";
import assert from "node:assert/strict";
import { detectProject } from "../services/detectionEngine.js";
import { findAppDirectory } from "../services/deploymentEngine.js";

const tree = (...paths) => paths.map((path) => ({ path, type: path.endsWith("/") ? "tree" : "blob" }));

test("Django with an HTML template and no requirements.txt is Django, port from EXPOSE", async () => {
  // Layout of LondheShubham153/django-todo-cicd.
  const files = tree(
    "Dockerfile", "manage.py", "db.sqlite3", "docker-compose.yml", "todoApp/__init__.py", "todoApp/settings.py", "todoApp/urls.py",
    "todoApp/wsgi.py", "todos/views.py", "todos/models.py", "todos/templates/todos/index.html", "staticfiles/css/style.css",
  );
  const detection = await detectProject(files, {
    Dockerfile: "FROM python:3\nRUN pip install django==3.2\nEXPOSE 8000\nCMD [\"python\",\"manage.py\",\"runserver\",\"0.0.0.0:8000\"]",
    "docker-compose.yml": "services:\n  web:\n    ports:\n      - \"3000:8000\"\n",
    "manage.py": "import os\n",
  });
  assert.equal(detection.framework, "Django");
  assert.equal(detection.language, "Python");
  assert.equal(detection.port, 8000);
  assert.match(detection.startCommand, /todoApp\.wsgi/);
});

test("a real static site is still static", async () => {
  const detection = await detectProject(tree("index.html", "css/site.css", "js/app.js"), {});
  assert.equal(detection.framework, "Static HTML / JS");
});

test("Express, Flask and FastAPI are recognised with their ports", async () => {
  const express = await detectProject(tree("package.json", "server.js"), {
    "package.json": JSON.stringify({ dependencies: { express: "^4.19.0" }, scripts: { start: "node server.js" } }),
    "server.js": "const app = require('express')();\napp.listen(process.env.PORT || 4000);",
  });
  assert.equal(express.framework, "Express");
  assert.equal(express.port, 4000);

  const flask = await detectProject(tree("app.py", "requirements.txt", "templates/index.html"), {
    "requirements.txt": "Flask==3.0.0\ngunicorn\n",
    "app.py": "from flask import Flask\napp = Flask(__name__)\n",
  });
  assert.equal(flask.framework, "Flask");

  const fastapi = await detectProject(tree("main.py", "requirements.txt"), { "requirements.txt": "fastapi\nuvicorn\n", "main.py": "from fastapi import FastAPI\n" });
  assert.equal(fastapi.framework, "FastAPI");
});

test("apps in a subfolder are found; root apps stay at the root", () => {
  // Layout of tiangolo/full-stack-fastapi-template.
  assert.equal(findAppDirectory(tree("README.md", "docker-compose.yml", "backend/pyproject.toml", "backend/Dockerfile", "backend/app/main.py", "frontend/package.json", "frontend/index.html")), "backend");
  assert.equal(findAppDirectory(tree("README.md", "server/package.json", "server/index.js", "docs/package.json")), "server");
  assert.equal(findAppDirectory(tree("package.json", "src/index.js", "backend/requirements.txt")), null);
  assert.equal(findAppDirectory(tree("README.md", "examples/demo/package.json")), null);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectFullStack, generateFullStackDockerfile, frontendBuildDefaults, inlineBackendDockerfile } from "../services/fullStackBuilder.js";
import { databaseNames, databaseEnvironment, managedDatabaseKeys } from "../services/rdsService.js";

function workspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skyforge-fullstack-"));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

test("client/ + server/ repositories are built as one full-stack container", () => {
  // Layout of shivanshks06/cloudops.
  const root = workspace({
    "package.json": { scripts: { build: "npm run build --prefix client" }, devDependencies: { concurrently: "^9" } },
    "client/package.json": { scripts: { build: "vite build" }, dependencies: { react: "^19" }, devDependencies: { vite: "^8" } },
    "client/index.html": "<div id=root></div>",
    "client/src/services/socket.js": "export const socket = io(import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_API_URL || \"http://localhost:5000\");",
    "server/package.json": { scripts: { start: "node server.js", migrate: "node-pg-migrate" }, dependencies: { express: "^5" } },
    "server/server.js": "const PORT = process.env.PORT || 5000;",
    "server/Dockerfile": "FROM node:24-alpine\nEXPOSE 5000\nCMD [\"sh\", \"-c\", \"npm run migrate up && node server.js\"]\n",
  });
  const stack = detectFullStack(root);
  assert.equal(stack.frontend.dir, "client");
  assert.equal(stack.backend.dir, "server");
  assert.equal(stack.backend.port, 5000);
  assert.deepEqual(stack.backend.command, ["sh", "-c", "npm run migrate up && node server.js"]);
  assert.equal(stack.nodeMajor, 24);
  const dockerfile = generateFullStackDockerfile(stack, { publicEnvKeys: ["VITE_SOCKET_URL"] });
  assert.match(dockerfile, /COPY client\/ \.\//);
  assert.match(dockerfile, /ARG VITE_SOCKET_URL/);
  assert.match(dockerfile, /EXPOSE 80/);
  // Socket URLs default to this site and API base URLs to "" (same origin) when the owner set none.
  assert.deepEqual(frontendBuildDefaults(root, stack, []).defaults, { VITE_SOCKET_URL: "/", VITE_API_URL: "" });
  assert.deepEqual(frontendBuildDefaults(root, stack, ["VITE_SOCKET_URL", "VITE_API_URL"]).defaults, {});

  // A single app at the root, or a Next.js frontend (needs its own server), is not this layout.
  assert.equal(detectFullStack(workspace({ "package.json": { dependencies: { express: "^5" } }, "client/package.json": { scripts: { build: "vite build" }, devDependencies: { vite: "^8" } }, "server/package.json": { dependencies: { express: "^5" } }, "server/index.js": "" })), null);
  assert.equal(detectFullStack(workspace({ "client/package.json": { scripts: { build: "next build" }, dependencies: { next: "^15" } }, "server/package.json": { dependencies: { express: "^5" } }, "server/index.js": "" })), null);
});

test("server-rendered frontend + FastAPI with its own Dockerfile (Lexa-AI layout)", () => {
  const root = workspace({
    "frontend/package.json": { scripts: { build: "vite build" }, dependencies: { "@tanstack/react-start": "1.0.0", react: "^19" }, devDependencies: { vite: "^7" } },
    "frontend/bun.lock": "",
    "frontend/src/lib/api.ts": "const BASE_URL = (import.meta.env[\"VITE_API_BASE_URL\"] ?? \"http://localhost:8001\");",
    "backend/pyproject.toml": "[project]\ndependencies = [\"fastapi\", \"uvicorn\"]\n",
    "backend/Dockerfile": "FROM python:3.12-slim\nRUN apt-get update && apt-get install -y ffmpeg\nWORKDIR /srv\nCOPY pyproject.toml uv.lock ./\nCOPY app ./app\nEXPOSE 8000\nCMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}\n",
    "backend/app/api/routes/health.py": "router = APIRouter(prefix=\"/health\")",
    "backend/app/api/routes/chat.py": "router = APIRouter(prefix=\"/api/v1/sessions\")\nawait client.post(\"/chat/completions\")",
  });
  const stack = detectFullStack(root);
  assert.equal(stack.frontend.kind, "ssr");
  assert.equal(stack.backend.kind, "docker");
  assert.equal(stack.backend.framework, "fastapi");
  assert.equal(stack.backend.port, 8000);
  assert.deepEqual(stack.backend.command, ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]);
  // Outgoing calls (/chat/completions) are not API mounts; /api and /health are.
  assert.ok(stack.backend.prefixes.includes("/api") && stack.backend.prefixes.includes("/health"));
  assert.ok(!stack.backend.prefixes.includes("/chat"));
  const dockerfile = generateFullStackDockerfile(stack, { publicEnvKeys: ["VITE_API_BASE_URL"] });
  assert.match(dockerfile, /COPY backend\/pyproject\.toml backend\/uv\.lock \.\//);
  assert.match(dockerfile, /COPY backend\/app \.\/app/);
  assert.match(dockerfile, /ENV NITRO_PRESET=node-server/);
  assert.match(dockerfile, /ENV SKYFORGE_BACKEND_CWD="\/srv"/);
  assert.ok(dockerfile.includes("--port \\${PORT:-8000}"), "the start command keeps ${PORT} for the shell, escaped from Docker");
  assert.ok(!/^CMD uvicorn/m.test(dockerfile), "the backend CMD is run by the gateway, not by Docker");
  assert.deepEqual(frontendBuildDefaults(root, stack, []).defaults, { VITE_API_BASE_URL: "" });
});

test("backend Dockerfile paths are rewritten for the repository root", () => {
  const inlined = inlineBackendDockerfile([
    "FROM node:22 AS backend",
    "WORKDIR /app",
    "COPY --chown=node . .",
    "COPY [\"a b.txt\", \"/x/\"]",
    "COPY --from=backend /app/dist /dist",
    "USER node",
    "ENTRYPOINT [\"node\"]",
    "CMD [\"server.js\"]",
  ].join("\n"), "api");
  assert.match(inlined.text, /AS backend_backend/);
  assert.match(inlined.text, /COPY --chown=node api \./);
  assert.match(inlined.text, /COPY \["api\/a b\.txt","\/x\/"\]/);
  assert.match(inlined.text, /COPY --from=backend \/app\/dist \/dist/);
  assert.deepEqual(inlined.command, ["node", "server.js"]);
  assert.equal(inlined.user, "node");
  assert.equal(inlined.workdir, "/app");
});

test("managed database names and connection variables", () => {
  const names = databaseNames("cloudops-1a2b3c4d5e");
  assert.equal(names.identifier, "cloudops-1a2b3c4d5e-db");
  assert.match(names.dbName, /^[a-z][a-z0-9_]*$/);
  assert.match(databaseNames("9app-x").identifier, /^sf-9app-x-db$/);
  const env = databaseEnvironment({ engine: "postgres", endpoint: "db.example.rds.amazonaws.com", port: 5432, dbName: "cloudops", password: "p@ss/word" });
  assert.equal(env.DATABASE_URL, "postgresql://skyforge:p%40ss%2Fword@db.example.rds.amazonaws.com:5432/cloudops");
  assert.equal(env.PGHOST, "db.example.rds.amazonaws.com");
  assert.ok(managedDatabaseKeys("mysql").includes("MYSQL_URL"));
  assert.ok(!managedDatabaseKeys("postgres").includes("MYSQL_URL"));
});

test.after(async () => {
  const [{ default: redis }, { default: prisma }] = await Promise.all([import("../redis/connection.js"), import("../config/db.js")]);
  redis.disconnect();
  await prisma.$disconnect();
});
