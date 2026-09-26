import test from "node:test";
import assert from "node:assert/strict";
import { validateDockerfile } from "../services/dockerValidator.js";

test("a runnable multi-stage Dockerfile passes validation", () => {
  const result = validateDockerfile(`FROM node:22-alpine AS build\nWORKDIR /app\nCOPY . .\nRUN npm run build\nFROM nginx:alpine\nCOPY --from=build /app/dist /usr/share/nginx/html\nEXPOSE 80\nCMD ["nginx", "-g", "daemon off;"]`);
  assert.equal(result.isValid, true);
  assert.equal(result.checks.hasFrom, true);
  assert.equal(result.checks.hasCmd, true);
  assert.equal(result.details.isMultiStage, true);
});

test("an image without a start command is rejected", () => {
  const result = validateDockerfile("FROM node:22-alpine\nWORKDIR /app");
  assert.equal(result.isValid, false);
  assert.match(result.errors.join(" "), /CMD|ENTRYPOINT/);
});
