import crypto from "node:crypto";

/**
 * Deception: files that look like leaked secrets but hold a "honey" AWS key belonging to an IAM
 * user with no permissions. Nobody legitimate ever reads them, so any use of the honey key proves
 * an attacker downloaded a decoy, and AWS records where they used it from.
 *
 * Served by the firewall (Protected tier, ECS targets) or uploaded next to the site (S3 targets).
 */

export const DECOY_FILES = [
  { key: "env", paths: ["/.env", "/.env.production", "/.env.local", "/.env.backup", "/.env.bak", "/env", "/.env.save"] },
  { key: "aws", paths: ["/.aws/credentials", "/.aws/config", "/aws.json", "/credentials.json"] },
];

// Trap paths advertised in robots.txt "Disallow" lines. Crawlers that obey robots.txt never visit
// them; scanners read robots.txt precisely to find hidden areas, and get banned.
export const BAIT_PATHS = ["/admin-backup/", "/internal/export/", "/db-dumps/", "/old-site/", "/private-api/"];

const random = (length, alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") =>
  Array.from(crypto.randomBytes(length), (byte) => alphabet[byte % alphabet.length]).join("");

/** A stable fake (per project) so repeated downloads look like the same real file. */
function seeded(seed, label, length) {
  const digest = crypto.createHash("sha256").update(`${seed}:${label}`).digest("base64").replace(/[^A-Za-z0-9]/g, "");
  return (digest + digest).slice(0, length);
}

export function decoyContents({ appName, honeyKeyId, honeySecret, seed = appName }) {
  const db = appName.replace(/[^a-z0-9]/gi, "_").slice(0, 20).toLowerCase() || "app";
  const env = [
    "APP_ENV=production",
    "NODE_ENV=production",
    "DEBUG=false",
    `APP_KEY=base64:${seeded(seed, "appkey", 43)}=`,
    `DATABASE_URL=postgres://${db}_admin:${seeded(seed, "dbpass", 24)}@${db}-prod.cluster-${seeded(seed, "cluster", 12).toLowerCase()}.internal:5432/${db}`,
    `REDIS_URL=redis://:${seeded(seed, "redis", 20)}@cache.internal:6379/0`,
    `JWT_SECRET=${seeded(seed, "jwt", 48)}`,
    "AWS_REGION=us-east-1",
    `AWS_ACCESS_KEY_ID=${honeyKeyId}`,
    `AWS_SECRET_ACCESS_KEY=${honeySecret}`,
    `S3_BACKUP_BUCKET=${db}-prod-backups`,
    `SMTP_PASSWORD=${seeded(seed, "smtp", 20)}`,
    "",
  ].join("\n");
  const aws = [
    "[default]",
    `aws_access_key_id = ${honeyKeyId}`,
    `aws_secret_access_key = ${honeySecret}`,
    "region = us-east-1",
    "",
    "[backup]",
    `aws_access_key_id = ${honeyKeyId}`,
    `aws_secret_access_key = ${honeySecret}`,
    "",
  ].join("\n");
  return { env, aws };
}

/** Firewall decoys: [{ key, paths, content }]. */
export function firewallDecoys({ appName, honeyKeyId, honeySecret, servedRoutes = [] }) {
  const contents = decoyContents({ appName, honeyKeyId, honeySecret });
  const served = servedRoutes.map((route) => String(route).toLowerCase().replace(/\/+$/, ""));
  return DECOY_FILES.map((file) => ({
    key: file.key,
    // Never shadow a path the app really serves.
    paths: file.paths.filter((path) => !served.includes(path.toLowerCase())),
    content: contents[file.key],
  })).filter((file) => file.paths.length);
}

export function robotsBait({ sitemap = null } = {}) {
  return [
    "User-agent: *",
    ...BAIT_PATHS.map((path) => `Disallow: ${path}`),
    "",
    ...(sitemap ? [`Sitemap: ${sitemap}`] : []),
  ].join("\n");
}

/** True when the app serves its own robots.txt (then the bait version is not used). */
export function appServesRobots(sourceFiles = [], routes = []) {
  return sourceFiles.some((file) => /(^|\/)robots\.txt$/i.test(file.path) || /robots\.txt/.test(file.content?.slice?.(0, 200000) || "") && /\.(js|ts|py|rb|php|go|java)$/.test(file.path))
    || routes.some((route) => /robots\.txt/i.test(route));
}

/** Static-site decoy objects: [{ key, body, contentType }] relative to the site root. */
export function staticDecoyObjects({ appName, honeyKeyId, honeySecret, hasRobots }) {
  const contents = decoyContents({ appName, honeyKeyId, honeySecret });
  const objects = [
    { key: ".env", body: contents.env, contentType: "text/plain" },
    { key: ".env.production", body: contents.env, contentType: "text/plain" },
    { key: ".aws/credentials", body: contents.aws, contentType: "text/plain" },
  ];
  if (!hasRobots) objects.push({ key: "robots.txt", body: robotsBait(), contentType: "text/plain" });
  return objects;
}

/** Rotating admin door token: unguessable, URL safe. */
export const newDoorToken = () => random(32, "abcdefghijkmnopqrstuvwxyz23456789");
