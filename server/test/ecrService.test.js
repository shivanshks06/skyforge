import test from "node:test";
import assert from "node:assert/strict";
import { getRepositoryName, pushImageToEcr } from "../services/ecrService.js";
import redis from "../redis/connection.js";

function repositoryNotFound() {
  const error = new Error("repository does not exist");
  error.name = "RepositoryNotFoundException";
  return error;
}

test("ECR repository identity is checkpointed before later push operations can fail", async () => {
  const project = { id: "project-1", name: "Example App" };
  const checkpoints = [];
  const client = {
    async send(command) {
      if (command.constructor.name === "DescribeRepositoriesCommand") throw repositoryNotFound();
      if (command.constructor.name === "CreateRepositoryCommand") return { repository: { repositoryName: getRepositoryName(project) } };
      if (command.constructor.name === "GetAuthorizationTokenCommand") throw new Error("temporary authorization failure");
      throw new Error(`Unexpected command: ${command.constructor.name}`);
    },
  };

  await assert.rejects(
    () => pushImageToEcr(
      "deployment-1",
      project,
      { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-east-1" },
      "local-tag",
      async (resources) => checkpoints.push(resources),
      { ecrClient: client, log: () => {} },
    ),
    (error) => {
      assert.equal(error.message, "temporary authorization failure");
      assert.equal(error.resources.type, "ECS_FARGATE");
      assert.equal(error.resources.repositoryName, getRepositoryName(project));
      assert.equal(error.resources.region, "us-east-1");
      return true;
    },
  );

  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[0].repositoryName, getRepositoryName(project));
  assert.equal(checkpoints.at(-1).repositoryName, getRepositoryName(project));
});

test.after(() => redis.disconnect());
