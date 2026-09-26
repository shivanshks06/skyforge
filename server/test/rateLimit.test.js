import test from "node:test";
import assert from "node:assert/strict";
import { rateLimit, resetRateLimits } from "../middleware/rateLimit.js";

function response() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("rate limiting rejects requests over the configured window budget", () => {
  resetRateLimits();
  const middleware = rateLimit({ windowMs: 60_000, max: 2, prefix: "test" });
  const req = { ip: "127.0.0.1" };
  let nextCalls = 0;
  const next = () => { nextCalls += 1; };

  middleware(req, response(), next);
  middleware(req, response(), next);
  const blocked = response();
  middleware(req, blocked, next);

  assert.equal(nextCalls, 2);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.body.retryAfter > 0, true);
  assert.equal(blocked.headers["Retry-After"] > 0, true);
  resetRateLimits();
});
