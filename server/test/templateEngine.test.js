import test from "node:test";
import assert from "node:assert/strict";
import { generateDockerfile } from "../services/templateEngine.js";
import { detectProject } from "../services/detectionEngine.js";

test("framework template selection is case-insensitive and supports Laravel", () => {
  const dockerfile = generateDockerfile({ framework: "laravel", language: "php", port: 8000 });
  assert.match(dockerfile, /php:8\.3-apache/);
  assert.match(dockerfile, /DocumentRoot \/var\/www\/html\/public/);
  assert.match(dockerfile, /EXPOSE 8000/);
});

test("Go templates discover the main package and follow the go.mod toolchain", () => {
  const dockerfile = generateDockerfile({ framework: "Go (Gin)", language: "Go", port: 8080 });
  assert.match(dockerfile, /GOTOOLCHAIN=auto/);
  assert.match(dockerfile, /go list -f '\{\{if eq \.Name "main"\}\}/);
  assert.match(dockerfile, /CMD \["server"\]/);
});

test("Next.js templates create an optional public directory and honor the start command", () => {
  const dockerfile = generateDockerfile({
    framework: "next.js",
    language: "TypeScript",
    buildCommand: "npm run build",
    startCommand: "npm run start",
    port: 3000,
  });
  assert.match(dockerfile, /mkdir -p public/);
  assert.match(dockerfile, /CMD \["sh", "-c", "npm run start"\]/);
});

test("Rust templates prefer the package binary and run it on glibc", () => {
  const dockerfile = generateDockerfile({ framework: "Rust", language: "Rust", binaryName: "app", port: 8080 });
  assert.match(dockerfile, /BIN="target\/release\/app"/);
  assert.match(dockerfile, /FROM debian:bookworm-slim/);
});

test("Spring Boot selects the matching Maven or Gradle builder", () => {
  const gradle = generateDockerfile({ framework: "Spring Boot", language: "Java", buildTool: "Gradle", port: 8080 });
  assert.match(gradle, /FROM gradle:/);
  assert.match(gradle, /build\/libs/);
});

test("repository detection defaults non-Docker React apps to ECS Fargate", async () => {
  const tree = [
    { path: "package.json", type: "blob" },
    { path: "vite.config.ts", type: "blob" },
    { path: "src/main.tsx", type: "blob" },
  ];
  const files = {
    "package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "19.0.0" } }),
    "vite.config.ts": "export default {}",
    "src/main.tsx": "import React from 'react';",
  };
  const detection = await detectProject(tree, files);
  assert.equal(detection.framework, "React + Vite");
  assert.equal(detection.deploymentTarget, "AWS ECS Fargate");
});

test("Django detection derives the WSGI module from the project package", async () => {
  const tree = ["manage.py", "todoApp/__init__.py", "todoApp/settings.py", "todoApp/wsgi.py"].map((path) => ({ path, type: "blob" }));
  const detection = await detectProject(tree, { "manage.py": "import django" });
  assert.equal(detection.startCommand, "gunicorn todoApp.wsgi:application --bind 0.0.0.0:8000");
  const dockerfile = generateDockerfile({ framework: "Django", language: "Python", port: 8000, startCommand: detection.startCommand });
  assert.match(dockerfile, /else \\\s+pip install --no-cache-dir django;/);
  assert.match(dockerfile, /gunicorn todoApp\.wsgi:application/);
});
