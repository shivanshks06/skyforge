import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planBuild } from "../services/buildPlanner.js";

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skyforge-plan-"));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

function plan(files) {
  const root = repo(files);
  try {
    return planBuild(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("Django uses the project package that holds wsgi.py", () => {
  const result = plan({ "manage.py": "", "todoApp/wsgi.py": "", "todoApp/settings.py": "" });
  assert.equal(result.metadata.framework, "Django");
  assert.match(result.metadata.startCommand, /gunicorn todoApp\.wsgi:application --bind 0\.0\.0\.0:8000/);
});

test("Flask and FastAPI start from the module and variable that create the app", () => {
  const flask = plan({ "requirements.txt": "flask", "server.py": "from flask import Flask\napplication = Flask(__name__)\n" });
  assert.match(flask.metadata.startCommand, /gunicorn .* server:application$/);
  assert.equal(flask.port, 5000);
  const fastapi = plan({ "requirements.txt": "fastapi", "api/main.py": "from fastapi import FastAPI\napi = FastAPI()\n" });
  assert.match(fastapi.metadata.startCommand, /^cd api && exec uvicorn main:api --host 0\.0\.0\.0 --port 8000$/);
});

test("Node servers without a start script run their entry file on the detected port", () => {
  const result = plan({ "package.json": { dependencies: { express: "4" } }, "src/server.js": "app.listen(process.env.PORT || 4000)" });
  assert.equal(result.metadata.framework, "Express");
  assert.equal(result.metadata.startCommand, "node src/server.js");
  assert.equal(result.port, 4000);
});

test("frontend builds are served by nginx on port 80, servers with a frontend are not", () => {
  const spa = plan({ "package.json": { scripts: { build: "vite build", dev: "vite" }, dependencies: { react: "18", vite: "5" } } });
  assert.equal(spa.metadata.framework, "Frontend SPA");
  assert.equal(spa.port, 80);
  const fullstack = plan({ "package.json": { scripts: { build: "vite build", start: "node server.js" }, dependencies: { express: "4", vite: "5" } }, "server.js": "" });
  assert.equal(fullstack.metadata.startCommand, "npm start");
  const nextExport = plan({ "package.json": { dependencies: { next: "14" }, scripts: { build: "next build" } }, "next.config.js": "module.exports = { output: 'export' }" });
  assert.match(nextExport.metadata.framework, /\(SPA\)$/);
  const nextServer = plan({ "package.json": { dependencies: { next: "16" }, scripts: { build: "next build" } }, "next.config.mjs": "const c = {\n  // output: \"export\",\n};" });
  assert.equal(nextServer.metadata.framework, "Next.js");
});

test("the app root is found in a subfolder and static sites serve the folder with index.html", () => {
  const java = plan({ "README.md": "", "complete/pom.xml": "<java.version>17</java.version>", "initial/pom.xml": "" });
  assert.equal(java.relativeRoot, "complete");
  assert.equal(java.metadata.javaVersion, "17");
  const site = plan({ "README.md": "", "docs/index.html": "<h1>hi</h1>" });
  assert.equal(site.relativeRoot, "docs");
  assert.equal(site.metadata.framework, "Static HTML");
});

test("Ruby, .NET, and Dockerfile-only repositories are deployable; empty ones explain why not", () => {
  const sinatra = plan({ Gemfile: "gem 'sinatra'", "app.rb": "require 'sinatra'" });
  assert.match(sinatra.metadata.startCommand, /bundle exec ruby app\.rb -o 0\.0\.0\.0 -p 4567/);
  const dotnet = plan({ "Web/Web.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net6.0</TargetFramework></PropertyGroup></Project>' });
  assert.equal(dotnet.metadata.dotnetVersion, "6.0");
  const docker = plan({ Dockerfile: "FROM busybox\nEXPOSE 9000\n", "main.zig": "" });
  assert.equal(docker.strategy, "repository");
  assert.equal(docker.port, 9000);
  assert.throws(() => plan({ "README.md": "nothing to run" }), /No deployable web application/);
});

test("runtime versions come from .tool-versions and legacy toolchains", () => {
  const python = plan({ "requirements.txt": "fastapi", ".tool-versions": "python 3.10.5\n", "main.py": "from fastapi import FastAPI\napp = FastAPI()\n" });
  assert.equal(python.metadata.pythonVersion, "3.10");
  const gatsby = plan({ "package.json": { scripts: { build: "gatsby build" }, dependencies: { gatsby: "^3.0.0" } } });
  assert.equal(gatsby.metadata.nodeVersion, "16");
  const sass = plan({ "package.json": { scripts: { build: "webpack" }, devDependencies: { "node-sass": "^4.14.1", webpack: "4" } } });
  assert.equal(sass.metadata.nodeVersion, "14");
  const modern = plan({ "package.json": { scripts: { build: "vite build" }, devDependencies: { vite: "5" } }, ".nvmrc": "20" });
  assert.equal(modern.metadata.nodeVersion, "20");
});

test("Jekyll sites build to static HTML instead of running as a Ruby server", () => {
  const site = plan({ Gemfile: "gem 'jekyll', '~> 4.3'", "_config.yml": "title: Blog", "_layouts/default.html": "{{ content }}", "index.md": "# Hi" });
  assert.equal(site.metadata.framework, "Jekyll");
  assert.equal(site.port, 80);
});
