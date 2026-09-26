import test from "node:test";
import assert from "node:assert/strict";
import { isBlockedSecretFile } from "../services/secretFilePolicy.js";

test("secret-file policy blocks real environment files but permits documented examples", () => {
  assert.equal(isBlockedSecretFile(".env"), true);
  assert.equal(isBlockedSecretFile(".env.production"), true);
  assert.equal(isBlockedSecretFile("id_ed25519"), true);
  assert.equal(isBlockedSecretFile("private.pem"), true);
  assert.equal(isBlockedSecretFile(".env.example"), false);
  assert.equal(isBlockedSecretFile(".env.sample"), false);
  assert.equal(isBlockedSecretFile(".env.template"), false);
});
