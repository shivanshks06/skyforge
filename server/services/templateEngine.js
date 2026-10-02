import fs from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

// Framework template generators
import { generateReactViteDockerfile } from "../templates/docker/react-vite.js";
import { generateExpressDockerfile } from "../templates/docker/express.js";
import { generateNextJsDockerfile } from "../templates/docker/nextjs.js";
import { generatePythonDockerfile, generateFastApiDockerfile, generateFlaskDockerfile, generateDjangoDockerfile } from "../templates/docker/python.js";
import { generateGoDockerfile } from "../templates/docker/go.js";
import { generatePhpDockerfile } from "../templates/docker/php.js";
import { generateRustDockerfile } from "../templates/docker/rust.js";
import { generateSpringBootDockerfile } from "../templates/docker/springboot.js";
import { generateStaticDockerfile } from "../templates/docker/static.js";
import { generateRubyDockerfile, generateJekyllDockerfile } from "../templates/docker/ruby.js";
import { generateDotnetDockerfile } from "../templates/docker/dotnet.js";
import { generateDockerignore } from "../templates/docker/dockerignore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATED_DIR = path.join(__dirname, "../generated");

/**
 * Template Engine Service (Sprint 6)
 * Generates framework-specific production Dockerfiles, .dockerignore files,
 * persists generated files to disk under generated/:projectId/, and synthesizes Terraform blueprints.
 */

export { generateDockerignore };

/**
 * Generate production-ready multi-stage Dockerfile based on detected framework & metadata
 */
function safeCommand(value, fallback = "") {
  if (value === null || value === undefined || value === "") return fallback;
  const command = String(value);
  if (/[\0\r\n]/.test(command)) throw new Error("Docker build and start commands must be single-line values.");
  return command;
}

export function generateDockerfile(project = {}, plan = {}) {
  const framework = String(project.framework || "Generic");
  const frameworkKey = framework.toLowerCase();
  const language = String(project.language || "");
  const languageKey = language.toLowerCase();
  const metadata = {
    framework,
    language,
    packageManager: String(project.packageManager || "npm").toLowerCase(),
    buildTool: project.buildTool || "",
    buildCommand: safeCommand(project.buildCommand),
    startCommand: safeCommand(project.startCommand),
    port: project.port ?? 3000,
  };
  // Optional hints resolved by the build planner from the checked-out source.
  for (const key of ["nodeVersion", "pythonVersion", "javaVersion", "rubyVersion", "dotnetVersion", "staticRoot", "docRoot", "binaryName", "projectFile", "fallbackBuildCommand"]) {
    if (project[key] !== undefined && project[key] !== null && project[key] !== "") metadata[key] = String(project[key]);
  }

  // Kinds chosen by the build planner: static-output SPAs and Node-served meta-frameworks.
  if (frameworkKey.includes("(spa)") || frameworkKey === "frontend spa") return generateReactViteDockerfile(metadata);
  if (frameworkKey.includes("(node)")) return generateExpressDockerfile(metadata);

  // Next.js must be checked before generic React metadata.
  if (frameworkKey.includes("next")) {
    return generateNextJsDockerfile(metadata);
  }

  // React, Vite, Vue, Svelte SPAs
  if (!frameworkKey.includes("sveltekit") && ["react", "vite", "vue", "svelte", "angular", "preact", "astro", "spa"].some((name) => frameworkKey.includes(name))) {
    return generateReactViteDockerfile(metadata);
  }

  // Ruby (Jekyll sites, Rails, Sinatra, Rack) and .NET
  if (frameworkKey.includes("jekyll")) return generateJekyllDockerfile(metadata);
  if (languageKey === "ruby" || frameworkKey.includes("rails") || frameworkKey.includes("sinatra")) return generateRubyDockerfile(metadata);
  if (languageKey === "c#" || languageKey === ".net" || frameworkKey.includes("asp.net") || frameworkKey.includes(".net")) return generateDotnetDockerfile(metadata);

  // Python Frameworks
  if (frameworkKey === "fastapi") return generateFastApiDockerfile(metadata);
  if (frameworkKey === "flask") return generateFlaskDockerfile(metadata);
  if (frameworkKey === "django") return generateDjangoDockerfile(metadata);
  if (languageKey === "python") return generatePythonDockerfile(metadata);

  // Go
  if (languageKey === "go" || frameworkKey === "go" || frameworkKey.startsWith("go ") || frameworkKey.includes("gin") || frameworkKey.includes("fiber")) {
    return generateGoDockerfile(metadata);
  }

  // Rust
  if (languageKey === "rust" || frameworkKey.includes("actix") || frameworkKey.includes("axum")) {
    return generateRustDockerfile(metadata);
  }

  // Java / Spring Boot
  if (frameworkKey === "spring boot" || languageKey === "java") {
    return generateSpringBootDockerfile(metadata);
  }

  // Laravel and other PHP applications
  if (frameworkKey.includes("laravel") || languageKey === "php") {
    return generatePhpDockerfile(metadata);
  }

  // Static HTML/CSS/JS
  if (frameworkKey.includes("static") || frameworkKey.includes("html") || languageKey === "html") {
    return generateStaticDockerfile(metadata);
  }

  // Node.js Backend (Express, Nest, etc.)
  if (
    frameworkKey.includes("express")
    || frameworkKey.includes("node")
    || frameworkKey.includes("nest")
    || languageKey === "javascript"
    || languageKey === "typescript"
  ) {
    return generateExpressDockerfile(metadata);
  }

  // Default fallback for repositories with no detectable server runtime.
  return generateStaticDockerfile(metadata);
}

/**
 * Save generated Docker files to server/generated/:projectId/
 */
export function saveGeneratedDockerFiles(projectId, dockerfileContent, dockerignoreContent) {
  if (!projectId) {
    throw new Error("projectId is required to save generated Docker files");
  }

  const projectDir = path.resolve(GENERATED_DIR, projectId);
  if (!projectDir.startsWith(`${path.resolve(GENERATED_DIR)}${path.sep}`)) {
    throw new Error("Invalid project ID.");
  }
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  const dockerfilePath = path.join(projectDir, "Dockerfile");
  const dockerignorePath = path.join(projectDir, ".dockerignore");

  fs.writeFileSync(dockerfilePath, dockerfileContent, "utf-8");
  fs.writeFileSync(dockerignorePath, dockerignoreContent ?? "", "utf-8");

  return {
    success: true,
    dockerPath: `generated/${projectId}/Dockerfile`,
    dockerignorePath: `generated/${projectId}/.dockerignore`,
    absoluteDockerPath: dockerfilePath,
    absoluteDockerignorePath: dockerignorePath,
  };
}

/**
 * Read generated Docker files from server/generated/:projectId/ if they exist
 */
export function getGeneratedDockerFiles(projectId) {
  if (!projectId) return null;

  const projectDir = path.resolve(GENERATED_DIR, projectId);
  if (!projectDir.startsWith(`${path.resolve(GENERATED_DIR)}${path.sep}`)) return null;
  const dockerfilePath = path.join(projectDir, "Dockerfile");
  const dockerignorePath = path.join(projectDir, ".dockerignore");

  let dockerfile = null;
  let dockerignore = null;

  if (fs.existsSync(dockerfilePath)) {
    dockerfile = fs.readFileSync(dockerfilePath, "utf-8");
  }
  if (fs.existsSync(dockerignorePath)) {
    dockerignore = fs.readFileSync(dockerignorePath, "utf-8");
  }

  return {
    dockerfile,
    dockerignore,
    exists: Boolean(dockerfile),
  };
}

/**
 * Generate Terraform configuration files populated with project attributes
 */
export function generateTerraform(project, plan = {}, envValues = {}) {
  const baseAppName = (project.name || "skyforge-app").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "skyforge-app";
  const stableId = crypto.createHash("sha256").update(String(project.id || "unknown")).digest("hex").slice(0, 10);
  const appName = `${baseAppName.slice(0, 12)}-${stableId}`;
  const region = process.env.AWS_REGION || "us-east-1";
  const hclString = (value) => JSON.stringify(String(value));
  const cpuMap = { "0.25 vCPU": "256", "0.5 vCPU": "512", "1 vCPU": "1024", "2 vCPU": "2048" };
  const memMap = { "512 MB": "512", "1 GB": "1024", "2 GB": "2048", "4 GB": "4096" };

  const cpuUnits = cpuMap[plan.cpu] || "512";
  const memoryMb = memMap[plan.memory] || "1024";
  const port = Number.isInteger(Number(project.port)) && Number(project.port) > 0 && Number(project.port) <= 65535 ? Number(project.port) : 80;
  const healthCheck = plan.healthCheck || "/";

  const tfVars = `# SkyForge infrastructure preview
app_name            = ${hclString(appName)}
aws_region          = ${hclString(region)}
cpu                 = ${hclString(cpuUnits)}
memory              = ${hclString(memoryMb)}
container_port      = ${port}
health_check_path   = ${hclString(healthCheck)}
container_image     = "REPLACE_WITH_VERIFIED_ECR_IMAGE_URI"
environment_variables = {}
`;

  // Read template main.tf
  let mainTf = "";
  try {
    const templatePath = path.join(__dirname, "../templates/terraform/ecs-fargate/main.tf");
    mainTf = fs.readFileSync(templatePath, "utf-8");
  } catch (err) {
    mainTf = `# ECS Fargate Terraform Module\n# Run terraform init && terraform apply`;
  }

  return {
    mainTf,
    tfVars,
    appName,
    cpuUnits,
    memoryMb,
  };
}
