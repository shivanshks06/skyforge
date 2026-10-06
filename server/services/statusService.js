// Uptime history (from the once-a-minute health monitor) and the public status page built from it.
import crypto from "node:crypto";
import prisma from "../config/db.js";

const DAY = 24 * 3600_000;

function hourStart(date = new Date()) {
  const hour = new Date(date);
  hour.setUTCMinutes(0, 0, 0);
  return hour;
}

/** Adds one health-check result to the current hour's tally. */
export async function recordUptime(projectId, ok, latencyMs = 0) {
  const hour = hourStart();
  const latency = Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : 0;
  await prisma.uptimeBucket.upsert({
    where: { projectId_hour: { projectId, hour } },
    create: { projectId, hour, checks: 1, failures: ok ? 0 : 1, latencyTotal: ok ? latency : 0 },
    update: { checks: { increment: 1 }, failures: { increment: ok ? 0 : 1 }, latencyTotal: { increment: ok ? latency : 0 } },
  });
}

/** Per-day uptime for the last `days` days, oldest first. Days with no checks have uptime null. */
export async function uptimeHistory(projectId, days = 90) {
  const since = new Date(Date.now() - days * DAY);
  const buckets = await prisma.uptimeBucket.findMany({ where: { projectId, hour: { gte: since } }, orderBy: { hour: "asc" } });
  const byDay = new Map();
  for (const bucket of buckets) {
    const day = bucket.hour.toISOString().slice(0, 10);
    const entry = byDay.get(day) || { checks: 0, failures: 0, latencyTotal: 0 };
    entry.checks += bucket.checks;
    entry.failures += bucket.failures;
    entry.latencyTotal += bucket.latencyTotal;
    byDay.set(day, entry);
  }
  const result = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(Date.now() - offset * DAY).toISOString().slice(0, 10);
    const entry = byDay.get(day);
    const succeeded = entry ? entry.checks - entry.failures : 0;
    result.push({
      day,
      checks: entry?.checks || 0,
      failures: entry?.failures || 0,
      uptime: entry?.checks ? Math.round((succeeded / entry.checks) * 10000) / 100 : null,
      latencyMs: succeeded ? Math.round(entry.latencyTotal / succeeded) : null,
    });
  }
  return result;
}

function overall(history) {
  const checks = history.reduce((sum, day) => sum + day.checks, 0);
  const failures = history.reduce((sum, day) => sum + day.failures, 0);
  return checks ? Math.round(((checks - failures) / checks) * 10000) / 100 : null;
}

export function newStatusSlug(projectName) {
  const base = String(projectName || "site").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "site";
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

/** Everything the public status page shows. Never includes repository, account or AWS details. */
export async function publicStatus(slug) {
  if (!/^[a-z0-9-]{3,60}$/.test(String(slug || ""))) return null;
  const project = await prisma.project.findFirst({
    where: { statusPage: { path: ["slug"], equals: slug } },
    select: { id: true, name: true, siteOffline: true, statusPage: true, customDomain: true },
  });
  if (!project?.statusPage?.enabled) return null;
  const latest = await prisma.deployment.findFirst({
    where: { projectId: project.id, status: { notIn: ["CANCELLED"] } },
    orderBy: { createdAt: "desc" },
    select: { status: true, healthStatus: true, liveUrl: true, latencyMs: true, updatedAt: true },
  });
  const history = await uptimeHistory(project.id, 90);
  const live = latest && ["LIVE", "ROLLED_BACK"].includes(latest.status);
  let state = "unknown";
  if (project.siteOffline) state = "maintenance";
  else if (live && latest.healthStatus === "HEALTHY") state = "operational";
  else if (live && latest.healthStatus === "UNHEALTHY") state = "down";
  else if (latest && ["QUEUED", "BUILDING", "PUSHING", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "ROLLING_BACK"].includes(latest.status)) state = "updating";
  else if (!live) state = "offline";
  const recentIncidents = history
    .filter((day) => day.failures > 0)
    .slice(-10)
    .reverse()
    .map((day) => ({ day: day.day, failedChecks: day.failures, uptime: day.uptime }));
  return {
    name: project.statusPage.title || project.name,
    url: project.customDomain?.status === "ACTIVE" ? `https://${project.customDomain.domain}` : (live ? latest.liveUrl : null),
    state,
    latencyMs: live ? latest.latencyMs : null,
    checkedAt: latest?.updatedAt || null,
    uptime: { day: overall(history.slice(-1)), week: overall(history.slice(-7)), month: overall(history.slice(-30)), quarter: overall(history) },
    history: history.map(({ day, uptime, failures, latencyMs }) => ({ day, uptime, failures, latencyMs })),
    incidents: recentIncidents,
  };
}
