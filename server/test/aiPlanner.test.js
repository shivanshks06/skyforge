import test from "node:test";
import assert from "node:assert/strict";
import { generateDevOpsFallbackPlan, normalizePlan } from "../services/aiPlanner.js";

test("static frontend fallback selects private S3 and CloudFront", () => {
  const plan = generateDevOpsFallbackPlan({ framework: "React + Vite", port: 80 });
  assert.equal(plan.deploymentTarget, "AWS_S3_CLOUDFRONT");
  assert.equal(plan.terraformStrategy, "S3_CLOUDFRONT_TEMPLATE");
  assert.equal(plan.cpu, "0.25 vCPU");
});

test("static target detection includes analyzed framework display names", () => {
  assert.equal(generateDevOpsFallbackPlan({ framework: "Static HTML / JS" }).deploymentTarget, "AWS_S3_CLOUDFRONT");
  assert.equal(generateDevOpsFallbackPlan({ framework: "Vue" }).deploymentTarget, "AWS_S3_CLOUDFRONT");
});

test("AI sizing is normalized to a valid Fargate CPU and memory pair", () => {
  const plan = normalizePlan({ deploymentTarget: "AWS_ECS_FARGATE", cpu: "2 vCPU", memory: "512 MB" }, {});
  assert.equal(plan.cpu, "2 vCPU");
  assert.equal(plan.memory, "4 GB");
});

test("server runtime fallback selects ECS Fargate", () => {
  const plan = generateDevOpsFallbackPlan({ framework: "FastAPI", port: 8000 });
  assert.equal(plan.deploymentTarget, "AWS_ECS_FARGATE");
  assert.equal(plan.terraformStrategy, "FARGATE_TEMPLATE");
});
