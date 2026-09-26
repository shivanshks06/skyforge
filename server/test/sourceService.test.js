import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findFrontendWorkspace } from "../services/frontendWorkspace.js";

test("frontend workspace detection accepts an absolute repository root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skyforge-source-"));
  try {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
    const workspace = findFrontendWorkspace(root);
    assert.equal(workspace?.directory, root);
    assert.equal(workspace?.type, "PACKAGE");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
