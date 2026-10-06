import "./config/env.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import dns from "node:dns";
import net from "node:net";

if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}
if (typeof net.setDefaultAutoSelectFamily === "function") {
  net.setDefaultAutoSelectFamily(false);
}
import express from "express";
import cors from "cors";
import helmet from "helmet";
import prisma from "./config/db.js";
import connection, { getRedisStatus } from "./redis/connection.js";
import authRoutes from "./routes/authRoutes.js";
import githubRoutes from "./routes/githubRoutes.js";
import projectRoutes from "./routes/projectRoutes.js";
import awsRoutes from "./routes/awsRoutes.js";
import deploymentRoutes from "./routes/deploymentRoutes.js";
import alertRoutes from "./routes/alertRoutes.js";
import { getPublicStatus } from "./controllers/costController.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { encryptSecret } from "./services/secretService.js";
import { closeActiveLogStreams } from "./services/logsService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

function trustProxySetting(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized || normalized === "false" || normalized === "0") return false;
  if (normalized === "true" || normalized === "1") return 1;
  const hops = Number.parseInt(normalized, 10);
  if (Number.isInteger(hops) && hops >= 0 && hops <= 10) return hops;
  if (process.env.NODE_ENV === "production") throw new Error("TRUST_PROXY must be false, true, or a hop count between 0 and 10.");
  return false;
}
const defaultOrigins = process.env.NODE_ENV === "production"
  ? []
  : ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000"];
const configuredOrigins = String(process.env.CLIENT_URL || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = [...new Set([
  ...defaultOrigins,
  ...configuredOrigins.map((origin) => {
    try {
      return new URL(origin).origin;
    } catch {
      if (process.env.NODE_ENV === "production") throw new Error(`CLIENT_URL contains an invalid origin: ${origin}`);
      return null;
    }
  }).filter(Boolean),
])];
if (process.env.NODE_ENV === "production" && !process.env.CLIENT_URL) throw new Error("CLIENT_URL is required in production.");
if (process.env.NODE_ENV === "production" && String(process.env.JWT_SECRET || "").length < 32) {
  throw new Error("JWT_SECRET must be configured with at least 32 characters in production.");
}
if (process.env.NODE_ENV === "production") {
  if (!process.env.FIELD_ENCRYPTION_KEY) throw new Error("FIELD_ENCRYPTION_KEY is required in production.");
  encryptSecret("skyforge-startup-configuration-check");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required in production.");
  try {
    const databaseUrl = new URL(process.env.DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) throw new Error("unsupported protocol");
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL with URL-encoded credentials.");
  }
  if (!process.env.REDIS_URL && (!process.env.REDIS_HOST || !process.env.REDIS_PORT)) {
    throw new Error("REDIS_URL or REDIS_HOST/REDIS_PORT is required in production.");
  }
  if (process.env.ALLOW_INLINE_JOBS === "true") throw new Error("ALLOW_INLINE_JOBS must remain false in production.");
  for (const origin of allowedOrigins) {
    const parsedOrigin = new URL(origin);
    const localClient = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(origin);
    if (parsedOrigin.protocol !== "https:" && !localClient) throw new Error("CLIENT_URL must use HTTPS in production.");
  }
  if (process.env.SKYFORGE_AWS_ACCOUNT_ID && !/^\d{12}$/.test(process.env.SKYFORGE_AWS_ACCOUNT_ID)) {
    throw new Error("SKYFORGE_AWS_ACCOUNT_ID must be a 12-digit AWS account ID.");
  }
  if (process.env.AWS_ACCOUNT_ID && !/^\d{12}$/.test(process.env.AWS_ACCOUNT_ID)) {
    throw new Error("AWS_ACCOUNT_ID must be a 12-digit AWS account ID.");
  }
  if (process.env.ALLOW_PLATFORM_AWS === "true") {
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      throw new Error("Platform AWS credentials are required when ALLOW_PLATFORM_AWS=true.");
    }
    if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(process.env.AWS_REGION || "")) {
      throw new Error("AWS_REGION is required and must be valid when platform AWS is enabled.");
    }
  }
}

app.set("trust proxy", trustProxySetting(process.env.TRUST_PROXY));
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (process.env.NODE_ENV !== "production" && (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:"))) {
      return callback(null, true);
    }
    const error = new Error("Origin is not allowed by CORS.");
    error.statusCode = 403;
    return callback(error);
  },
  credentials: true,
}));
app.use(express.json({
  limit: "2mb",
  // GitHub webhooks are verified against the exact bytes GitHub signed.
  verify: (req, _res, buffer) => {
    if (req.originalUrl.startsWith("/api/github/webhook")) req.rawBody = buffer;
  },
}));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));

app.get(["/healthz", "/api/health"], (_req, res) => res.json({ status: "ok", service: "skyforge-api" }));
app.get("/readyz", async (_req, res) => {
  const checks = { database: false, redis: getRedisStatus().connected, worker: false };
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch {
    checks.database = false;
  }
  if (checks.redis) {
    checks.worker = Boolean(await connection.get("skyforge:worker:heartbeat").catch(() => null));
  }
  const ready = checks.database && (process.env.NODE_ENV !== "production" || (checks.redis && checks.worker));
  return res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks });
});

app.use("/api/auth", authRoutes);
app.use("/api/github", githubRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/aws", awsRoutes);
app.use("/api/deployments", deploymentRoutes);
app.use("/api/alerts", alertRoutes);
// Public status pages (no login).
app.get("/api/public/status/:slug", rateLimit({ windowMs: 60 * 1000, max: 120, prefix: "public-status", message: "Too many requests." }), getPublicStatus);

const clientDist = path.resolve(__dirname, "../client/dist");
if (process.env.SERVE_CLIENT === "true" && fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: "index.html" }));
  app.get("*splat", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

app.use((_req, res) => res.status(404).json({ message: "Route not found" }));
app.use((error, _req, res, _next) => {
  const status = error.statusCode || error.status || 500;
  if (status >= 500) console.error("[API] Unhandled request error:", error);
  if (res.headersSent) return;
  // Client errors (malformed JSON, CORS rejection) carry safe messages; never echo 5xx internals.
  res.status(status).json({ message: status < 500 ? (error.type === "entity.parse.failed" ? "Malformed JSON request body." : error.message) : "Internal server error" });
});

const port = Number.parseInt(process.env.PORT || "5000", 10);
let server;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server = app.listen(port, () => console.log(`SkyForge API listening on port ${port}`));
}

async function shutdown(signal) {
  console.log(`[API] Received ${signal}; shutting down...`);
  closeActiveLogStreams();
  if (server) await Promise.race([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  await prisma.$disconnect().catch(() => {});
  connection.disconnect();
  process.exit(0);
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

export default app;
