import test from "node:test";
import assert from "node:assert/strict";
import { AWS_TARGETS, determineDeploymentTarget } from "../services/infrastructurePlanner.js";

test("frontend projects default to the ECS Fargate target", () => {
  assert.equal(determineDeploymentTarget({ framework: "React + Vite" }), AWS_TARGETS.ECS_FARGATE);
});

test("explicit backend targets and frameworks use ECS Fargate", () => {
  assert.equal(determineDeploymentTarget({ framework: "React + Vite", deploymentTarget: "AWS ECS Fargate" }), AWS_TARGETS.ECS_FARGATE);
  assert.equal(determineDeploymentTarget({ framework: "FastAPI" }), AWS_TARGETS.ECS_FARGATE);
});
