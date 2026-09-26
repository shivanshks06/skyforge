import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDockerIgnoreFilter } from "../services/dockerIgnoreFilter.js";

test("streamed Docker contexts honor dockerignore patterns and required Dockerfiles", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skyforge-ignore-"));
  try {
    await fs.writeFile(path.join(root, ".dockerignore"), "node_modules\nsecrets/**\n!secrets/public.txt\n");
    const filter = createDockerIgnoreFilter(root, [".skyforge.Dockerfile"]);
    assert.equal(filter("."), true);
    assert.equal(filter("package.json"), true);
    assert.equal(filter("node_modules"), false);
    assert.equal(filter("node_modules/lodash/index.js"), false);
    assert.equal(filter("secrets/private.txt"), false);
    assert.equal(filter("secrets/public.txt"), true);
    assert.equal(filter(".skyforge.Dockerfile"), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
