import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { explainFailure, announcedPort, nextSize } from "../services/errorExplainer.js";
import { verifyWebhookSignature } from "../services/webhookSignature.js";
import { normalizeDomain, servingPoint } from "../services/domainService.js";

const project = { id: "p1", port: 3000, cpu: "0.5 vCPU", memory: "1 GB", healthCheck: "/" };
const failed = (error, currentStep = "HEALTH_CHECK") => ({ status: "FAILED", error, currentStep });

test("explains a port mismatch from the app's own output and offers the fix", () => {
  const diagnosis = explainFailure({
    deployment: failed("ECS service app-service did not become stable within 600 seconds."),
    project,
    logs: [{ message: "INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)" }],
  });
  assert.equal(diagnosis.id, "port-mismatch");
  assert.deepEqual(diagnosis.fixes[0], { kind: "runtime", label: "Use port 8000 and redeploy", patch: { port: 8000 }, redeploy: true });
});

test("explains out-of-memory with the next valid Fargate size", () => {
  const diagnosis = explainFailure({ deployment: failed("Essential container in task exited"), project, logs: ["FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"] });
  assert.equal(diagnosis.id, "out-of-memory");
  assert.deepEqual(diagnosis.fixes[0].patch, { cpu: "0.5 vCPU", memory: "2 GB" });
});

test("missing environment variables link to the environment page", () => {
  const diagnosis = explainFailure({ deployment: failed("Environment variable GROQ_API_KEY is not configured.", "CLONING"), project });
  assert.equal(diagnosis.id, "missing-env");
  assert.match(diagnosis.title, /GROQ_API_KEY/);
  assert.equal(diagnosis.fixes[0].to, "/project/p1/plan");
});

test("a database on localhost is recognised", () => {
  const diagnosis = explainFailure({ deployment: failed("did not become stable"), project, logs: ["Error: connect ECONNREFUSED 127.0.0.1:5432"] });
  assert.equal(diagnosis.id, "localhost-database");
});

test("missing packages name the package and the manifest", () => {
  const node = explainFailure({ deployment: failed("Health check failed"), project, logs: ["Error: Cannot find module 'express'"] });
  assert.equal(node.id, "missing-module");
  assert.match(node.title, /express/);
  const python = explainFailure({ deployment: failed("Health check failed"), project, logs: ["ModuleNotFoundError: No module named 'fastapi'"] });
  assert.match(python.explanation, /requirements\.txt/);
});

test("network failures suggest retrying; unknown errors still get an explanation", () => {
  assert.equal(explainFailure({ deployment: failed("GitHub source download failed: ETIMEDOUT", "CLONING"), project }).id, "network");
  const unknown = explainFailure({ deployment: failed("Something odd happened", "PUSHING"), project });
  assert.equal(unknown.id, "unknown");
  assert.match(unknown.title, /pushing/);
  assert.equal(explainFailure({ deployment: { status: "LIVE" }, project }), null);
});

test("announced ports ignore database ports and nonsense", () => {
  assert.equal(announcedPort("Server listening on port 5000"), 5000);
  assert.equal(announcedPort(" * Running on http://127.0.0.1:5001"), 5001);
  assert.equal(announcedPort("connected to postgres port 5432"), null);
  assert.equal(announcedPort("nothing here"), null);
});

test("next size steps up memory, then CPU, and stops at the top", () => {
  assert.deepEqual(nextSize("0.25 vCPU", "512 MB"), { cpu: "0.25 vCPU", memory: "1 GB" });
  assert.deepEqual(nextSize("1 vCPU", "2 GB"), { cpu: "1 vCPU", memory: "4 GB" });
  assert.equal(nextSize("2 vCPU", "4 GB"), null);
});

test("webhook signatures are verified against the shared secret", () => {
  const body = Buffer.from(JSON.stringify({ ref: "refs/heads/main" }));
  const good = `sha256=${crypto.createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  assert.equal(verifyWebhookSignature(body, good, "s3cret"), true);
  assert.equal(verifyWebhookSignature(body, good, "other"), false);
  assert.equal(verifyWebhookSignature(body, "sha256=abc", "s3cret"), false);
  assert.equal(verifyWebhookSignature(body, good, ""), false);
});

test("custom domains are normalised and AWS addresses rejected", () => {
  assert.equal(normalizeDomain("https://App.Example.com/path"), "app.example.com");
  assert.throws(() => normalizeDomain("localhost"), /Enter a domain/);
  assert.throws(() => normalizeDomain("x.elb.amazonaws.com"), /domain you own/);
});

test("the certificate goes where the site is served", () => {
  assert.deepEqual(servingPoint({ type: "S3_CLOUDFRONT", distributionId: "E1" }, "ap-south-1"), { via: "cloudfront", distributionId: "E1", certRegion: "us-east-1" });
  assert.equal(servingPoint({ type: "ECS_FARGATE", loadBalancerArn: "arn:alb", edgeDistributionId: "E2" }, "ap-south-1").via, "cloudfront");
  const alb = servingPoint({ type: "ECS_FARGATE", loadBalancerArn: "arn:alb", loadBalancerDns: "x.elb.amazonaws.com" }, "ap-south-1");
  assert.equal(alb.via, "alb");
  assert.equal(alb.certRegion, "ap-south-1");
  assert.equal(servingPoint(null, "ap-south-1"), null);
});
