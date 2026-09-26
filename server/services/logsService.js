import { EventEmitter } from "node:events";
import { createRedisConnection, getRedisStatus } from "../redis/connection.js";

const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(200);
const deploymentLogsCache = new Map();
const persistChains = new Map();
const activeStreams = new Set();

function channelFor(deploymentId) {
  return `skyforge:deployment-logs:${deploymentId}`;
}

function cacheLogs(deploymentId, entry) {
  if (!deploymentLogsCache.has(deploymentId)) {
    deploymentLogsCache.set(deploymentId, []);
    if (deploymentLogsCache.size > 1000) deploymentLogsCache.delete(deploymentLogsCache.keys().next().value);
  }
  const logs = deploymentLogsCache.get(deploymentId);
  if (!logs.some((item) => item.id === entry.id)) logs.push(entry);
  if (logs.length > 1000) logs.shift();
}

function queueDatabasePersistence(deploymentId, entry) {
  const previous = persistChains.get(deploymentId) || Promise.resolve();
  const next = previous.then(async () => {
    try {
      const { default: prisma } = await import("../config/db.js");
      const entryJson = JSON.stringify([entry]);
      await prisma.$executeRaw`
        UPDATE "Deployment"
        SET "logs" = (
          SELECT COALESCE(jsonb_agg(recent."entry"), '[]'::jsonb)
          FROM (
            SELECT entries."entry"
            FROM jsonb_array_elements(
              COALESCE("Deployment"."logs", '[]'::jsonb) || ${entryJson}::jsonb
            ) WITH ORDINALITY AS entries("entry", "ordinal")
            ORDER BY entries."ordinal" DESC
            LIMIT 1000
          ) AS recent
        ),
        "updatedAt" = CURRENT_TIMESTAMP
        WHERE "Deployment"."id" = ${deploymentId}
      `;
    } catch (error) {
      console.warn(`[LOGS] Could not persist deployment ${deploymentId}: ${error.message}`);
    }
  }).catch(() => {});
  persistChains.set(deploymentId, next);
  const release = () => {
    if (persistChains.get(deploymentId) === next) persistChains.delete(deploymentId);
  };
  next.then(release, release);
}

export function emitDeploymentLog(deploymentId, { stage = "PIPELINE", message = "", level = "info" } = {}) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    stage,
    message: String(message).slice(0, 2000),
    level,
  };
  cacheLogs(deploymentId, entry);
  logEmitter.emit(channelFor(deploymentId), entry);
  queueDatabasePersistence(deploymentId, entry);
  if (getRedisStatus().connected) {
    import("../redis/connection.js").then(({ default: redis }) => {
      redis.publish(channelFor(deploymentId), JSON.stringify(entry)).catch(() => {});
    }).catch(() => {});
  }
  return entry;
}

export function getDeploymentLogs(deploymentId) {
  return deploymentLogsCache.get(deploymentId) || [];
}

export async function persistDeploymentLogs(deploymentId, logs) {
  const { default: prisma } = await import("../config/db.js");
  await prisma.deployment.update({ where: { id: deploymentId }, data: { logs: (logs || []).slice(-1000) } });
}

export async function subscribeToDeploymentLogs(deploymentId, req, res) {
  activeStreams.add(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  let existingLogs = getDeploymentLogs(deploymentId);
  if (!existingLogs.length) {
    try {
      const { default: prisma } = await import("../config/db.js");
      const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId }, select: { logs: true } });
      if (Array.isArray(deployment?.logs)) existingLogs = deployment.logs;
    } catch (error) {
      console.warn(`[LOGS] Could not load history for ${deploymentId}: ${error.message}`);
    }
  }
  const sentIds = new Set();
  const send = (entry) => {
    const id = String(entry?.id || "");
    if (id && sentIds.has(id)) return;
    if (id) {
      sentIds.add(id);
      if (sentIds.size > 1000) sentIds.delete(sentIds.values().next().value);
    }
    try {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    } catch {
      // The request close handler removes the listener.
    }
  };
  for (const log of existingLogs) send(log);

  const channel = channelFor(deploymentId);
  logEmitter.on(channel, send);

  let subscriber;
  let redisListener;
  if (getRedisStatus().connected) {
    try {
      subscriber = createRedisConnection({ lazyConnect: true });
      subscriber.on("error", () => {});
      if (subscriber.status === "wait") await subscriber.connect();
      redisListener = (message) => {
        try {
          const entry = JSON.parse(message);
          cacheLogs(deploymentId, entry);
          send(entry);
        } catch {
          // Ignore malformed pub/sub messages.
        }
      };
      subscriber.on("message", redisListener);
      await subscriber.subscribe(channel);
    } catch (error) {
      console.warn(`[LOGS] Redis subscription unavailable: ${error.message}`);
      subscriber?.disconnect();
      subscriber = null;
    }
  }

  const heartbeat = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      // The connection will be closed by the request handler.
    }
  }, 15_000);

  req.on("close", () => {
    activeStreams.delete(res);
    clearInterval(heartbeat);
    logEmitter.off(channel, send);
    if (subscriber && redisListener) subscriber.off("message", redisListener);
    if (subscriber) {
      subscriber.unsubscribe(channel).catch(() => {});
      subscriber.disconnect();
    }
    res.end();
  });
}

export function closeActiveLogStreams() {
  for (const response of activeStreams) {
    try { response.end(); } catch {}
  }
  activeStreams.clear();
}
