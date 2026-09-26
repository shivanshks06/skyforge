import test from "node:test";
import assert from "node:assert/strict";
import { AWS_TARGETS, determineDeploymentTarget } from "../services/infrastructurePlanner.js";

test("static frontend projects default to the S3 CloudFront target", () => {
  assert.equal(determineDeploymentTarget({ framework: "React + Vite" }), AWS_TARGETS.S3_CLOUDFRONT);
});

test("explicit backend targets and frameworks use ECS Fargate", () => {
  assert.equal(determineDeploymentTarget({ framework: "React + Vite", deploymentTarget: "AWS ECS Fargate" }), AWS_TARGETS.ECS_FARGATE);
  assert.equal(determineDeploymentTarget({ framework: "FastAPI" }), AWS_TARGETS.ECS_FARGATE);
});
