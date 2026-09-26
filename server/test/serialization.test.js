import test from "node:test";
import assert from "node:assert/strict";
import { toPublicProject } from "../services/projectSerializer.js";
import { toPublicDeployment } from "../services/deploymentSerializer.js";

test("public project responses omit encrypted environment configuration", () => {
  const project = toPublicProject({ id: "p1", name: "App", envConfig: { SECRET: "enc:v1:ciphertext" }, dockerPath: "generated/p1/Dockerfile", terraformPath: "generated/p1/terraform" });
  assert.deepEqual(project, { id: "p1", name: "App" });
  assert.equal("envConfig" in project, false);
});

test("public deployment responses omit internal artifact paths", () => {
  const deployment = toPublicDeployment({ id: "d1", status: "LIVE", artifactPath: "/app/generated/secret-path", workerJobId: "internal-job", resources: { secretArn: "internal" }, teardownResources: [{ secretArn: "internal" }], teardownDeploymentIds: ["d0"] });
  assert.equal(deployment.artifactPath, undefined);
  assert.equal(deployment.workerJobId, undefined);
  assert.equal(deployment.resources, undefined);
  assert.equal(deployment.teardownResources, undefined);
  assert.equal(deployment.teardownDeploymentIds, undefined);
  assert.equal(deployment.status, "LIVE");
});
