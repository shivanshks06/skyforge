import crypto from "node:crypto";

const ENCRYPTION_PREFIX = "enc:v1:";
export const MASKED_SECRET = "********";
const ALGORITHM = "aes-256-gcm";
let warnedAboutDevelopmentKey = false;

function getEncryptionKey() {
  const configured = process.env.FIELD_ENCRYPTION_KEY?.trim();

  if (configured) {
    const key = /^[a-f0-9]{64}$/i.test(configured)
      ? Buffer.from(configured, "hex")
      : Buffer.from(configured, "base64");

    if (key.length !== 32) {
      throw new Error("FIELD_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or 64-character hex).");
    }
    return key;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("FIELD_ENCRYPTION_KEY is required in production.");
  }

  if (!warnedAboutDevelopmentKey) {
    console.warn("[SECRETS] FIELD_ENCRYPTION_KEY is not set; using a development-only key derived from JWT_SECRET.");
    warnedAboutDevelopmentKey = true;
  }

  return crypto
    .createHash("sha256")
    .update(process.env.JWT_SECRET || "skyforge-development-only-secret")
    .digest();
}

export function isEncryptedSecret(value) {
  return typeof value === "string" && value.startsWith(ENCRYPTION_PREFIX);
}

export function encryptSecret(value) {
  if (value === null || value === undefined || value === "") return value;
  if (isEncryptedSecret(value)) return value;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTION_PREFIX}${Buffer.concat([iv, authTag, encrypted]).toString("base64")}`;
}

export function decryptSecret(value) {
  if (value === null || value === undefined || value === "") return value;
  if (!isEncryptedSecret(value)) return value;

  const payload = Buffer.from(value.slice(ENCRYPTION_PREFIX.length), "base64");
  if (payload.length < 29) {
    throw new Error("Encrypted secret payload is invalid.");
  }

  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function encryptObjectValues(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, encryptSecret(entry)]),
  );
}

export function decryptObjectValues(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, decryptSecret(entry)]),
  );
}

export function maskObjectValues(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    entry === undefined || entry === null || String(entry) === "" ? "" : MASKED_SECRET,
  ]));
}

export function maskSecret(value, visibleStart = 4, visibleEnd = 4) {
  const plainValue = String(decryptSecret(value) || "");
  if (!plainValue) return null;
  if (plainValue.length <= visibleStart + visibleEnd) return "•".repeat(plainValue.length);
  return `${plainValue.slice(0, visibleStart)}${"•".repeat(8)}${plainValue.slice(-visibleEnd)}`;
}
