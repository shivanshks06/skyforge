// What AWS is actually charging, and a monthly budget that can alert or take sites offline.
// Actual spend comes from Cost Explorer, which AWS bills at $0.01 per request, so results are cached for 6 hours.
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import prisma from "../config/db.js";
import redis, { getRedisStatus } from "../redis/connection.js";
import { estimateInfrastructureCost } from "./costEstimator.js";
import { normalizeTarget, TARGETS } from "./targets.js";
import { sendAlert } from "./alertService.js";
import { isStaticResources } from "./securityService.js";
import { takeSiteOffline } from "./ecsService.js";
import { takeStaticSiteOffline } from "./staticDeployer.js";

const CACHE_SECONDS = 6 * 60 * 60;
const memoryCache = new Map();

const isoDay = (date) => date.toISOString().slice(0, 10);
const round = (value) => Math.round(value * 100) / 100;

async function cached(key, compute, refresh) {
  if (!refresh) {
    if (getRedisStatus().connected) {
      const hit = await redis.get(key).catch(() => null);
      if (hit) return JSON.parse(hit);
    } else if (memoryCache.has(key) && memoryCache.get(key).expires > Date.now()) {
      return memoryCache.get(key).value;
    }
  }
  const value = await compute();
  if (getRedisStatus().connected) await redis.set(key, JSON.stringify(value), "EX", CACHE_SECONDS).catch(() => {});
  else memoryCache.set(key, { value, expires: Date.now() + CACHE_SECONDS * 1000 });
  return value;
}

/** Month-to-date spend for the whole AWS account, by day and by service, with a straight-line forecast. */
export async function accountSpend({ credentials, refresh = false }) {
  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const key = `skyforge:cost:${credentials.accountId || credentials.accessKeyId?.slice(-6)}:${monthKey}`;
  return cached(key, async () => {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const client = new CostExplorerClient({
      region: "us-east-1",
      credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}) },
    });
    const result = await client.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: isoDay(start), End: isoDay(end) },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    }));
    const byService = new Map();
    const daily = [];
    let currency = "USD";
    for (const day of result.ResultsByTime || []) {
      let total = 0;
      for (const group of day.Groups || []) {
        const amount = Number.parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
        currency = group.Metrics?.UnblendedCost?.Unit || currency;
        total += amount;
        const service = group.Keys?.[0] || "Other";
        byService.set(service, (byService.get(service) || 0) + amount);
      }
      daily.push({ date: day.TimePeriod?.Start, amount: round(total) });
    }
    const monthToDate = daily.reduce((sum, day) => sum + day.amount, 0);
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const daysElapsed = Math.max(1, now.getUTCDate());
    return {
      currency,
      monthToDate: round(monthToDate),
      forecast: round((monthToDate / daysElapsed) * daysInMonth),
      daily,
      byService: [...byService.entries()].map(([service, amount]) => ({ service, amount: round(amount) })).filter((item) => item.amount >= 0.01).sort((a, b) => b.amount - a.amount),
      fetchedAt: new Date().toISOString(),
      note: "Cost Explorer data lags a few hours behind real usage. The forecast assumes the rest of the month looks like the days so far.",
    };
  }, refresh);
}

/** Rough cost of running a project before it is deployed, from its target, size and database. */
export function projectedCost(project) {
  const target = normalizeTarget(project.deploymentTarget);
  if (!target) return null;
  const blueprint = estimateInfrastructureCost(target, { cpu: project.cpu || "0.5 vCPU", memory: project.memory || "1 GB" });
  let monthly = Number.parseFloat(String(blueprint.total).replace(/[^0-9.]/g, "")) || 0;
  const items = [{ label: target === TARGETS.S3_CLOUDFRONT ? "Static hosting (S3 + CloudFront)" : "Container + load balancer", monthly }];
  if (project.databaseConfig?.mode === "managed" && target !== TARGETS.S3_CLOUDFRONT) {
    items.push({ label: "Managed database (db.t4g.micro + 20 GB)", monthly: 14.5 });
    monthly += 14.5;
  }
  return { monthly: round(monthly), daily: round(monthly / 30), items, note: "Estimate before traffic. Real costs depend on usage; free-tier allowances can make it lower." };
}

export function normalizeBudget(input = {}) {
  const monthlyUsd = Number(input.monthlyUsd);
  if (!Number.isFinite(monthlyUsd) || monthlyUsd < 0 || monthlyUsd > 100_000) {
    const error = new Error("Budget must be a number between 0 and 100000 (0 turns it off).");
    error.statusCode = 400;
    throw error;
  }
  const action = input.action === "offline" ? "offline" : "alert";
  return { monthlyUsd: round(monthlyUsd), action };
}

async function takeEverythingOffline(userId, credentials) {
  const projects = await prisma.project.findMany({ where: { userId, siteOffline: false }, select: { id: true, name: true } });
  const done = [];
  for (const project of projects) {
    const live = await prisma.deployment.findFirst({ where: { projectId: project.id, status: { in: ["LIVE", "ROLLED_BACK"] } }, orderBy: { createdAt: "desc" }, select: { resources: true } });
    if (!live?.resources) continue;
    try {
      if (isStaticResources(live.resources)) await takeStaticSiteOffline({ credentials, resources: live.resources });
      else await takeSiteOffline({ credentials, resources: live.resources });
      await prisma.project.update({ where: { id: project.id }, data: { siteOffline: true, status: "Offline" } });
      done.push(project.name);
    } catch (error) {
      console.warn(`[BUDGET] Could not take ${project.name} offline: ${error.message}`);
    }
  }
  return done;
}

/** Compares spend with the person's budget; alerts once per level per month and optionally takes sites offline. */
export async function checkBudget(userId, credentials) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { budget: true, alertSettings: true } });
  const budget = user?.budget;
  if (!budget?.monthlyUsd) return null;
  const spend = await accountSpend({ credentials });
  const month = new Date().toISOString().slice(0, 7);
  const level = spend.monthToDate >= budget.monthlyUsd ? "over" : spend.forecast >= budget.monthlyUsd ? "forecast" : spend.monthToDate >= budget.monthlyUsd * 0.8 ? "near" : null;
  if (!level || budget.alerted?.[month]?.includes(level)) return { level, spend };
  const actions = [];
  if (level === "over" && budget.action === "offline") {
    const offline = await takeEverythingOffline(userId, credentials);
    if (offline.length) actions.push(`Took ${offline.length} site(s) offline: ${offline.join(", ")} (load balancers still bill; destroy projects to stop all charges)`);
  }
  const titles = {
    over: `AWS spend is over your budget: $${spend.monthToDate} of $${budget.monthlyUsd} this month`,
    forecast: `AWS spend is on track to pass your budget: forecast $${spend.forecast} vs $${budget.monthlyUsd}`,
    near: `AWS spend reached 80% of your budget: $${spend.monthToDate} of $${budget.monthlyUsd}`,
  };
  await sendAlert(user.alertSettings, {
    severity: level === "over" ? "high" : "medium",
    title: titles[level],
    projectName: "All projects (AWS account)",
    summary: `Biggest costs so far: ${spend.byService.slice(0, 3).map((item) => `${item.service} $${item.amount}`).join(", ") || "none yet"}.`,
    actions,
    nextSteps: ["Open Costs in SkyForge to see which services cost the most", "Destroy projects you no longer need (One-Click Destroy removes everything)"],
  }).catch(() => []);
  const alerted = { ...(budget.alerted || {}), [month]: [...(budget.alerted?.[month] || []), level] };
  await prisma.user.update({ where: { id: userId }, data: { budget: { ...budget, alerted: { [month]: alerted[month] } } } });
  return { level, spend, actions };
}
