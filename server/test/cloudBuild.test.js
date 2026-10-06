import test from "node:test";
import assert from "node:assert/strict";
import { useEcrPublicMirror, builderBucketName } from "../services/cloudBuildService.js";
import redis from "../redis/connection.js";

test.after(() => redis.disconnect());

test("official Docker Hub images are pulled from Amazon ECR Public in cloud builds", () => {
  const dockerfile = [
    "FROM node:22-bookworm-slim AS skyforge_frontend",
    "FROM --platform=linux/amd64 python:3.12-slim",
    "FROM library/nginx:alpine",
    "FROM skyforge_frontend AS again",
    "FROM bitnami/redis:7",
    "FROM ghcr.io/astral-sh/uv:0.11 AS uv",
    "FROM public.ecr.aws/lambda/python:3.12",
    "COPY --from=node:22-alpine /usr/local/bin/node /usr/local/bin/node",
    "COPY --from=skyforge_frontend /site /skyforge/frontend",
    "COPY --from=ghcr.io/astral-sh/uv:0.11.23 /uv /usr/local/bin/uv",
    "FROM scratch",
  ].join("\n");
  const out = useEcrPublicMirror(dockerfile).split("\n");
  assert.equal(out[0], "FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS skyforge_frontend");
  assert.equal(out[1], "FROM --platform=linux/amd64 public.ecr.aws/docker/library/python:3.12-slim");
  assert.equal(out[2], "FROM public.ecr.aws/docker/library/nginx:alpine");
  assert.equal(out[3], "FROM skyforge_frontend AS again", "build stages are never rewritten");
  assert.equal(out[4], "FROM bitnami/redis:7", "other Docker Hub namespaces are not mirrored");
  assert.equal(out[5], "FROM ghcr.io/astral-sh/uv:0.11 AS uv");
  assert.equal(out[6], "FROM public.ecr.aws/lambda/python:3.12");
  assert.equal(out[7], "COPY --from=public.ecr.aws/docker/library/node:22-alpine /usr/local/bin/node /usr/local/bin/node");
  assert.equal(out[8], "COPY --from=skyforge_frontend /site /skyforge/frontend");
  assert.equal(out[9], "COPY --from=ghcr.io/astral-sh/uv:0.11.23 /uv /usr/local/bin/uv");
  assert.equal(out[10], "FROM scratch");
  assert.equal(builderBucketName("365370369267", "ap-south-1"), "skyforge-builds-365370369267-ap-south-1");
});
