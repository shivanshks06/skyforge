import test from "node:test";
import assert from "node:assert/strict";
import { probeEndpoint } from "../services/healthService.js";

test("production health probes reject non-HTTPS and untrusted hosts before network access", async () => {
  const previous = process.env.NODE_ENV;
  const previousCustomHosts = process.env.ALLOW_CUSTOM_HEALTH_HOSTS;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(() => probeEndpoint("http://127.0.0.1:5000/healthz", { attempts: 1 }), /HTTPS/);
    await assert.rejects(() => probeEndpoint("https://localhost:5000/healthz", { attempts: 1 }), /Local deployment endpoints/);
    await assert.rejects(() => probeEndpoint("https://metadata.example.invalid/health", { attempts: 1 }), /not allowed/);
    process.env.ALLOW_CUSTOM_HEALTH_HOSTS = "true";
    await assert.rejects(() => probeEndpoint("https://[::ffff:7f00:1]/health", { attempts: 1 }), /non-public address/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
    if (previousCustomHosts === undefined) delete process.env.ALLOW_CUSTOM_HEALTH_HOSTS;
    else process.env.ALLOW_CUSTOM_HEALTH_HOSTS = previousCustomHosts;
  }
});
