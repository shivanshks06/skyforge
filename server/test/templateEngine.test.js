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

test("Go templates normalize a custom output binary to the runtime path", () => {
  const dockerfile = generateDockerfile({
    framework: "Go (Gin)",
    language: "Go",
    buildCommand: "CGO_ENABLED=0 go build -o main .",
    port: 8080,
  });
  assert.match(dockerfile, /cp "\/app\/main" \/app\/server/);
  assert.match(dockerfile, /CMD \["\.\/server"\]/);
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

test("Rust templates map release binary paths into the runtime image", () => {
  const dockerfile = generateDockerfile({ framework: "Rust", language: "Rust", startCommand: "./target/release/app", port: 8080 });
  assert.match(dockerfile, /CMD \["sh", "-c", "\/app\/bin\/app"\]/);
});

test("Spring Boot selects the matching Maven or Gradle builder", () => {
  const gradle = generateDockerfile({ framework: "Spring Boot", language: "Java", buildTool: "Gradle", port: 8080 });
  assert.match(gradle, /FROM gradle:/);
  assert.match(gradle, /build\/libs/);
});

test("repository detection defaults non-Docker React apps to static hosting", async () => {
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
  assert.equal(detection.deploymentTarget, "AWS_S3_CLOUDFRONT");
});
