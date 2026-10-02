import fs from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { planInfrastructure } from "./infrastructurePlanner.js";
import { estimateInfrastructureCost } from "./costEstimator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATES_DIR = path.join(__dirname, "../templates/terraform");
const GENERATED_DIR = path.join(__dirname, "../generated");

/**
 * Terraform Engine Service (Sprint 7)
 * Synthesizes modular, production-ready Terraform Infrastructure as Code (IaC),
 * writes files to server/generated/:projectId/terraform/, and produces infrastructure.json.
 */

export function generateTerraformBlueprints(project = {}, plan = {}, requestedRegion = null) {
  const infraPlan = planInfrastructure(project);
  const target = infraPlan.target;
  const cost = estimateInfrastructureCost(target, { cpu: plan.cpu, memory: plan.memory });

  const baseAppName = (project.name || "skyforge-app").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "skyforge-app";
  const stableId = crypto.createHash("sha256").update(String(project.id || "unknown")).digest("hex").slice(0, 10);
  const appName = `${baseAppName.slice(0, 12)}-${stableId}`;
  const region = String(requestedRegion || process.env.AWS_REGION || "us-east-1");
  const port = Number.isInteger(Number(project.port)) && Number(project.port) > 0 && Number(project.port) <= 65535 ? Number(project.port) : 3000;
  const healthCheck = /^\/[A-Za-z0-9/_-]*$/.test(plan.healthCheck || "") ? plan.healthCheck : "/";
  const hclString = (value) => JSON.stringify(String(value));

  const cpuMap = { "0.25 vCPU": "256", "0.5 vCPU": "512", "1 vCPU": "1024", "2 vCPU": "2048" };
  const memMap = { "512 MB": "512", "1 GB": "1024", "2 GB": "2048", "4 GB": "4096" };
  const cpuUnits = cpuMap[plan.cpu] || "512";
  const memoryMb = memMap[plan.memory] || "1024";

  const files = {};

  const ecsTemplateDir = path.join(TEMPLATES_DIR, "ecs-fargate");
  const moduleNames = ["main.tf", "variables.tf", "outputs.tf", "networking.tf", "ecs.tf", "iam.tf"];

  for (const mod of moduleNames) {
    const p = path.join(ecsTemplateDir, mod);
    if (fs.existsSync(p)) {
      files[mod] = fs.readFileSync(p, "utf-8");
    }
  }

  files["terraform.tfvars"] = `# SkyForge ECS Fargate infrastructure preview
# Replace the image with the immutable ECR URI/digest emitted by a successful deployment.
app_name            = ${hclString(appName)}
aws_region          = ${hclString(region)}
cpu                 = ${hclString(cpuUnits)}
memory              = ${hclString(memoryMb)}
container_port      = ${port}
health_check_path   = ${hclString(healthCheck)}
container_image     = "REPLACE_WITH_VERIFIED_ECR_IMAGE_URI"
environment_variables = {}
`;


  // Infrastructure Manifest (infrastructure.json)
  const manifest = {
    provider: "AWS",
    authoritative: false,
    note: "Preview IaC only. The production worker uses the AWS SDK and records the actual resource manifest on the deployment.",
    deployment: target,
    region,
    displayName: infraPlan.displayName,
    services: infraPlan.services.map((s) => s.id.toUpperCase()),
    serviceDetails: infraPlan.services,
    architecture: infraPlan.architectureGraph,
    estimatedCost: cost.total,
    costBreakdown: cost.breakdown,
    files: Object.keys(files),
    specs: {
      appName,
      port,
      healthCheck,
      cpu: plan.cpu || "0.5 vCPU",
      memory: plan.memory || "1 GB",
    },
    generatedAt: new Date().toISOString(),
  };

  return {
    target,
    region,
    infraPlan,
    cost,
    manifest,
    files,
  };
}

/**
 * Persist Terraform files and infrastructure.json to server/generated/:projectId/terraform/
 */
export function saveTerraformFilesToDisk(projectId, blueprints) {
  if (!projectId) {
    throw new Error("projectId is required to save Terraform files");
  }

  const tfDir = path.resolve(GENERATED_DIR, projectId, "terraform");
  if (!tfDir.startsWith(`${path.resolve(GENERATED_DIR)}${path.sep}`)) throw new Error("Invalid project ID.");
  // Recreate the directory so switching targets cannot leave stale modules
  // (for example ECS networking files beside an S3 preview) that Terraform
  // would load together on the next run.
  fs.rmSync(tfDir, { recursive: true, force: true });
  fs.mkdirSync(tfDir, { recursive: true });

  // Write all modular .tf files
  for (const [filename, content] of Object.entries(blueprints.files)) {
    const filePath = path.join(tfDir, filename);
    fs.writeFileSync(filePath, content, "utf-8");
  }

  // Write infrastructure.json
  const manifestPath = path.join(GENERATED_DIR, projectId, "infrastructure.json");
  const tfManifestPath = path.join(tfDir, "infrastructure.json");
  const manifestStr = JSON.stringify(blueprints.manifest, null, 2);

  fs.writeFileSync(manifestPath, manifestStr, "utf-8");
  fs.writeFileSync(tfManifestPath, manifestStr, "utf-8");

  return {
    success: true,
    terraformPath: `generated/${projectId}/terraform`,
    manifestPath: `generated/${projectId}/infrastructure.json`,
    fileCount: Object.keys(blueprints.files).length,
  };
}
