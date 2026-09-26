import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { isMultiServiceProject, detectServices, setupMultiServiceWorkspace } from "../services/multiServiceBuilder.js";

test("multi-service builder correctly detects and setups microservice architecture", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skyforge-test-multi-"));
  try {
    const servicesDir = path.join(tmpDir, "services");
    await fs.mkdir(path.join(servicesDir, "auth"), { recursive: true });
    await fs.mkdir(path.join(servicesDir, "product"), { recursive: true });
    await fs.mkdir(path.join(servicesDir, "frontend"), { recursive: true });

    await fs.writeFile(path.join(servicesDir, "auth", "package.json"), JSON.stringify({ name: "auth" }));
    await fs.writeFile(path.join(servicesDir, "auth", "server.js"), "const express = require('express');");
    await fs.writeFile(path.join(servicesDir, "product", "package.json"), JSON.stringify({ name: "product" }));
    await fs.writeFile(path.join(servicesDir, "product", "server.js"), "const express = require('express');");
    await fs.writeFile(path.join(servicesDir, "frontend", "index.html"), "<h1>Hello</h1>");

    assert.equal(isMultiServiceProject(tmpDir), true);

    const services = detectServices(tmpDir);
    assert.equal(services.length, 3);
    assert.ok(services.some((s) => s.name === "auth" && s.port === 4000));
    assert.ok(services.some((s) => s.name === "product" && s.port === 4001));
    assert.ok(services.some((s) => s.name === "frontend" && s.isFrontend));

    await setupMultiServiceWorkspace(tmpDir, 80);
    const hasGateway = await fs.stat(path.join(tmpDir, "skyforge-gateway.mjs")).then(() => true).catch(() => false);
    const hasDns = await fs.stat(path.join(tmpDir, "skyforge-dns.cjs")).then(() => true).catch(() => false);
    const hasDockerfile = await fs.stat(path.join(tmpDir, "Dockerfile.multiservice")).then(() => true).catch(() => false);

    assert.equal(hasGateway, true);
    assert.equal(hasDns, true);
    assert.equal(hasDockerfile, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
