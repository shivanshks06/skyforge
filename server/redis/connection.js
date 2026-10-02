import "../config/env.js";
import Redis from "ioredis";

function getRedisOptions() {
  const url = process.env.REDIS_URL?.trim();
  if (url) {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: Number.parseInt(parsed.port || "6379", 10),
      username: parsed.username || undefined,
      password: parsed.password || undefined,
      tls: parsed.protocol === "rediss:" ? {} : undefined,
      db: parsed.pathname ? Number.parseInt(parsed.pathname.slice(1) || "0", 10) : undefined,
    };
  }

  return {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number.parseInt(process.env.REDIS_PORT || "6379", 10),
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === "true" ? {} : undefined,
  };
}

export function createRedisConnection(overrides = {}) {
  return new Redis({
    ...getRedisOptions(),
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (attempt) => Math.min(attempt * 500, 5000),
    ...overrides,
  });
}

const connection = createRedisConnection();
let lastError = null;

connection.on("error", (error) => {
  lastError = error;
  if (process.env.NODE_ENV === "production" || process.env.LOG_REDIS_ERRORS === "true") {
    console.warn(`[REDIS] ${error.message}`);
  }
});
connection.on("ready", () => {
  lastError = null;
});
connection.on("end", () => {
  lastError = new Error("Redis connection closed");
});

export const getRedisStatus = () => ({
  connected: connection.status === "ready",
  status: connection.status,
  error: lastError?.message || null,
});

export default connection;
