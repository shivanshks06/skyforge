import test from "node:test";
import assert from "node:assert/strict";
import { AWS_TARGETS, determineDeploymentTarget, planInfrastructure } from "../services/infrastructurePlanner.js";
import { normalizeTarget, looksStatic } from "../services/targets.js";

test("no deployment target is chosen automatically", () => {
  assert.equal(determineDeploymentTarget({ framework: "React + Vite" }), null);
  assert.equal(determineDeploymentTarget({ framework: "FastAPI" }), null);
  assert.equal(planInfrastructure({ framework: "Next.js" }), null);
});

test("explicit choices map to the three targets, including legacy labels", () => {
  assert.equal(normalizeTarget("AWS ECS Fargate"), AWS_TARGETS.ECS_FARGATE);
  assert.equal(normalizeTarget("AWS_ECS_CLOUDFRONT"), AWS_TARGETS.ECS_CLOUDFRONT);
  assert.equal(normalizeTarget("ECS Fargate + CloudFront"), AWS_TARGETS.ECS_CLOUDFRONT);
  assert.equal(normalizeTarget("AWS S3 + CloudFront CDN"), AWS_TARGETS.S3_CLOUDFRONT);
  assert.equal(normalizeTarget(""), null);
  assert.equal(normalizeTarget("kubernetes"), null);
  const edge = planInfrastructure({ name: "demo" }, AWS_TARGETS.ECS_CLOUDFRONT);
  assert.equal(edge.services[0].id, "cloudfront");
  assert.equal(planInfrastructure({ name: "demo" }, AWS_TARGETS.S3_CLOUDFRONT).target, AWS_TARGETS.S3_CLOUDFRONT);
});

test("static hosting is only offered to apps without a server", () => {
  assert.equal(looksStatic({ framework: "React + Vite" }), true);
  assert.equal(looksStatic({ framework: "Static HTML", language: "HTML" }), true);
  assert.equal(looksStatic({ framework: "Next.js" }), false);
  assert.equal(looksStatic({ framework: "Django" }), false);
});
