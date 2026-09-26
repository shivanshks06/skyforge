import test from "node:test";
import assert from "node:assert/strict";
import { mergeRollbackResources, uniqueResources, validateResourceManifests } from "../services/resourceUtils.js";

test("teardown deduplicates stable cloud identities across deployment revisions", () => {
  const deployments = [
    { resources: { type: "ECS_FARGATE", clusterName: "app-cluster", serviceName: "app-service", taskDefinitionArn: "task:2", secretName: null } },
    { resources: { type: "ECS_FARGATE", clusterName: "app-cluster", serviceName: "app-service", taskDefinitionArn: "task:1", secretName: "app/env", secretArn: "arn:secret" } },
    { resources: { type: "S3_CLOUDFRONT", bucket: "app-bucket", distributionId: "dist-1", releasePrefix: "releases/2/" } },
    { resources: { type: "S3_CLOUDFRONT", bucket: "app-bucket", distributionId: "dist-1", releasePrefix: "releases/1/" } },
  ];
  const resources = uniqueResources(deployments);
  assert.equal(resources.length, 2);
  assert.equal(resources[0].taskDefinitionArn, "task:2");
  assert.equal(resources[0].secretName, "app/env");
  assert.equal(resources[1].releasePrefix, "releases/2/");
});

test("teardown rejects malformed and unknown cloud resource manifests", () => {
  assert.throws(() => validateResourceManifests([{ type: "S3_CLOUDFRONT" }]), /bucket/);
  assert.throws(() => validateResourceManifests([{ type: "UNKNOWN", bucket: "valid-bucket" }]), /unsupported/);
  assert.throws(() => validateResourceManifests([{ type: "ECS_FARGATE" }]), /identity/);
  assert.throws(() => validateResourceManifests(uniqueResources([{ resources: "not-a-manifest" }])), /malformed/);
});

test("rollback manifests point at the restored static artifact revision", () => {
  const resources = mergeRollbackResources(
    { type: "S3_CLOUDFRONT", region: "us-east-1", bucket: "app-bucket", distributionId: "dist-1", releasePrefix: "releases/new/" },
    { type: "S3_CLOUDFRONT", region: "us-east-1", bucket: "app-bucket", distributionId: "dist-1", releasePrefix: "releases/old/", defaultRoot: "index.html" },
  );
  assert.equal(resources.releasePrefix, "releases/old/");
  assert.equal(resources.distributionId, "dist-1");
});

test("teardown accepts partial but verifiable ECR and S3 checkpoints", () => {
  const resources = validateResourceManifests([
    { type: "ECS_FARGATE", repositoryName: "skyforge-app-123" },
    { type: "S3_CLOUDFRONT", bucket: "skyforge-app-123" },
  ]);
  assert.equal(resources.length, 2);
});
