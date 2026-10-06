import crypto from "node:crypto";

/** Checks a GitHub webhook signature (X-Hub-Signature-256) against GITHUB_WEBHOOK_SECRET. */
export function verifyWebhookSignature(rawBody, signature, secret = process.env.GITHUB_WEBHOOK_SECRET) {
  if (!secret || !rawBody || !signature?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
