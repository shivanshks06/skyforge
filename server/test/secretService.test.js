import test from "node:test";
import assert from "node:assert/strict";
import { decryptObjectValues, decryptSecret, encryptObjectValues, encryptSecret, maskObjectValues, maskSecret } from "../services/secretService.js";

process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

test("secret values round-trip and plaintext values remain readable during migration", () => {
  const encrypted = encryptSecret("private-value");
  assert.notEqual(encrypted, "private-value");
  assert.equal(decryptSecret(encrypted), "private-value");
  assert.equal(decryptSecret("legacy-plaintext"), "legacy-plaintext");
});

test("object values are encrypted independently and masked without revealing the value", () => {
  const encrypted = encryptObjectValues({ API_TOKEN: "token-value", REGION: "eu-west-1" });
  assert.equal(encrypted.API_TOKEN.startsWith("enc:v1:"), true);
  assert.deepEqual(decryptObjectValues(encrypted), { API_TOKEN: "token-value", REGION: "eu-west-1" });
  assert.equal(maskSecret(encrypted.API_TOKEN), "toke••••••••alue");
});

test("malformed legacy environment JSON is masked as an empty object", () => {
  assert.deepEqual(maskObjectValues(null), {});
  assert.deepEqual(maskObjectValues("legacy-secret"), {});
  assert.deepEqual(maskObjectValues(["legacy-secret"]), {});
  assert.deepEqual(maskObjectValues(42), {});
});

test("tampered ciphertext fails authentication", () => {
  const encrypted = encryptSecret("do-not-tamper");
  const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => decryptSecret(tampered));
});
