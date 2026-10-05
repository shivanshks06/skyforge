import axios from "axios";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import prisma from "../config/db.js";
import { decryptSecret } from "./secretService.js";
import { resourceNames, takeSiteOffline, forceNewTasks } from "./ecsService.js";
import { takeStaticSiteOffline } from "./staticDeployer.js";
import { allowedTrafficSample, DOOR_PREFIX } from "./wafService.js";
import { newDoorToken } from "./deceptionService.js";
import { secretsInPatch, isSensitiveFile } from "./securityPolicy.js";
import { raiseIncident } from "./incidentService.js";
import {
  applyProtection, firewallSummary, isStaticResources, patchProtection, runLeakWatch, securitySettings, syncProjectSecurity, ensureScanToken,
} from "./securityService.js";

/**
 * Scheduled security work for each live project, driven by the monitor (once a minute per live
 * deployment). Every task keeps its own "last run" time in protection.automation, so each runs
 * at its own pace: bans and alerts every 10 minutes, rate-limit tuning and leak watch every 6
 * hours, CVE checks and admin-door rotation daily.
 */

const MINUTE = 60_000;
// Blocked requests per hour that count as an attack (CloudWatch's exact count; samples are only a subset).
const SPIKE_BLOCKS_PER_HOUR = Number(process.env.ATTACK_SPIKE_THRESHOLD || 300);

async function due(project, task, intervalMs) {
  const last = Date.parse(project.protection?.automation?.[task] || 0);
  return Date.now() - last >= intervalMs;
}

async function markRun(projectId, task) {
  await patchProtection(projectId, (current) => ({ automation: { ...(current.automation || {}), [task]: new Date().toISOString() } }));
}

async function freshProject(projectId) {
  return prisma.project.findUnique({ where: { id: projectId } });
}

/** Turns Under Attack mode on or off on the live firewall. */
export async function setUnderAttackMode({ project, credentials, resources, enabled, autoMinutes = null }) {
  await applyProtection({ project, credentials, resources, underAttack: enabled });
  await patchProtection(project.id, (current) => ({
    waf: current.waf ? { ...current.waf, underAttack: enabled, autoUnderAttackUntil: enabled && autoMinutes ? new Date(Date.now() + autoMinutes * MINUTE).toISOString() : null } : current.waf,
  }));
}

/** Takes the site offline (maintenance page) from an automatic response. */
export async function takeOfflineNow({ project, credentials, resources }) {
  if (isStaticResources(resources)) await takeStaticSiteOffline({ credentials, resources });
  else await takeSiteOffline({ credentials, resources });
  await prisma.project.update({ where: { id: project.id }, data: { siteOffline: true, status: "Offline" } });
}

// ---------------------------------------------------------------- incidents from the 10-minute sync

async function syncAndReport({ project, credentials, resources, deploymentId }) {
  const result = await syncProjectSecurity({ projectId: project.id, credentials });
  for (const event of result?.events || []) {
    const respond = event.kind === "canary.used"
      ? async (current) => {
        const actions = [];
        if (current.securityTier === "PROTECTED" && current.protection?.waf && !current.protection.waf.underAttack && resources?.loadBalancerArn) {
          await setUnderAttackMode({ project: current, credentials, resources, enabled: true, autoMinutes: 120 });
          actions.push("Under Attack mode switched on for 2 hours (strict rate limits and a bot challenge)");
        }
        actions.push("Recorded where and when the key was used");
        return actions;
      }
      : event.kind === "decoy.taken" || event.kind === "ip.banned"
        ? async () => [`Banned ${event.detail?.bans?.length || 0} IP(s) for 24 hours and shared them with your other protected projects`]
        : null;
    await raiseIncident({ projectId: project.id, deploymentId, ...event, respond });
  }
}

// ---------------------------------------------------------------- attack spikes (#6)

async function attackSpike({ project, credentials, resources, deploymentId }) {
  const waf = project.protection?.waf;
  if (project.securityTier !== "PROTECTED" || !waf?.webAclArn) return;
  const summary = await firewallSummary({ project, credentials, hours: 1 }).catch(() => null);
  if (!summary) return;
  const scope = waf.scope || "REGIONAL";
  const dims = [{ Name: "WebACL", Value: waf.webAclName }, { Name: "Rule", Value: "ALL" }, ...(scope === "REGIONAL" ? [{ Name: "Region", Value: credentials.region }] : [])];
  const metric = await metricSum(cloudWatch(credentials, scope === "CLOUDFRONT" ? "us-east-1" : credentials.region), { namespace: "AWS/WAFV2", metric: "BlockedRequests", dimensions: dims, hours: 1, period: 60 }).catch(() => null);
  const blocked = Math.max(metric?.total || 0, summary.sampledBlocked);
  await patchProtection(project.id, { attackRate: { blockedLastHour: blocked, at: new Date().toISOString() } });
  const autoUntil = Date.parse(waf.autoUnderAttackUntil || "");
  if (blocked >= SPIKE_BLOCKS_PER_HOUR) {
    await raiseIncident({
      projectId: project.id,
      deploymentId,
      kind: "attack.spike",
      severity: "high",
      title: `Attack in progress: ${Math.round(blocked)} malicious requests blocked in the last hour`,
      detail: { blockedLastHour: Math.round(blocked), byRule: summary.byRule, topIps: summary.topIps, topCountries: summary.topCountries, topPaths: summary.topPaths },
      dedupeMinutes: 60,
      respond: async (current) => {
        if (current.protection?.waf?.underAttack) return ["Under Attack mode was already on"];
        await setUnderAttackMode({ project: current, credentials, resources, enabled: true, autoMinutes: 60 });
        return ["Under Attack mode switched on (300 requests / 5 min per IP, 20 on login routes, bot challenge on page loads); it switches off automatically after an hour of calm"];
      },
    });
  } else if (waf.underAttack && autoUntil && autoUntil < Date.now() && blocked < SPIKE_BLOCKS_PER_HOUR / 5) {
    await setUnderAttackMode({ project, credentials, resources, enabled: false });
    await raiseIncident({ projectId: project.id, deploymentId, kind: "attack.calm", severity: "info", title: "Attack subsided: automatic Under Attack mode switched off", detail: { blockedLastHour: Math.round(blocked) }, dedupeMinutes: 30 });
  }
}

// ---------------------------------------------------------------- self-tuning rate limits (#7)

function cloudWatch(credentials, region) {
  return new CloudWatchClient({
    region,
    credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}) },
  });
}

async function metricSum(client, { namespace, metric, dimensions, hours = 24, period = 300, statistic = "Sum" }) {
  const end = new Date();
  const result = await client.send(new GetMetricStatisticsCommand({
    Namespace: namespace, MetricName: metric, Dimensions: dimensions,
    StartTime: new Date(end.getTime() - hours * 3600_000), EndTime: end, Period: period, Statistics: [statistic],
  }));
  const points = (result.Datapoints || []).map((point) => point[statistic] || 0);
  return { total: points.reduce((sum, value) => sum + value, 0), peak: points.length ? Math.max(...points) : 0, points: points.length };
}

const roundUp = (value, step) => Math.ceil(value / step) * step;

/**
 * Per-IP limits from real traffic: the busiest legitimate visitor's peak 5-minute rate (estimated
 * from sampled allowed requests and CloudWatch totals) times 3, bounded to sane ranges.
 */
export function tunedLimits({ samples = [], peakFiveMinute = 0, loginPattern = /login|signin|auth|token|session|password|register|admin/i }) {
  if (samples.length < 20 || peakFiveMinute <= 0) return null;
  const weight = (list) => list.reduce((sum, item) => sum + (item.weight || 1), 0);
  const total = weight(samples);
  const perIp = new Map();
  const perIpLogin = new Map();
  for (const sample of samples) {
    perIp.set(sample.ip, (perIp.get(sample.ip) || 0) + (sample.weight || 1));
    if (loginPattern.test(sample.path || "")) perIpLogin.set(sample.ip, (perIpLogin.get(sample.ip) || 0) + (sample.weight || 1));
  }
  const topShare = Math.max(...perIp.values()) / total;
  const topLoginShare = perIpLogin.size ? Math.max(...perIpLogin.values()) / total : 0;
  const busiest = topShare * peakFiveMinute;
  const busiestLogin = topLoginShare * peakFiveMinute;
  return {
    global: Math.min(20000, Math.max(500, roundUp(busiest * 3, 100))),
    login: Math.min(500, Math.max(30, roundUp(busiestLogin * 3, 10))),
    basis: { sampled: samples.length, peakFiveMinute: Math.round(peakFiveMinute), busiestVisitorPerFiveMinutes: Math.round(busiest) },
  };
}

async function tuneRateLimits({ project, credentials, resources }) {
  const waf = project.protection?.waf;
  if (project.securityTier !== "PROTECTED" || !waf?.webAclArn || !securitySettings(project).selfTuningLimits) return;
  const scope = waf.scope || "REGIONAL";
  const samples = await allowedTrafficSample({ credentials, appName: resourceNames(project).appName, webAclArn: waf.webAclArn, scope }).catch(() => []);
  const dims = [{ Name: "WebACL", Value: waf.webAclName }, { Name: "Rule", Value: "ALL" }, ...(scope === "REGIONAL" ? [{ Name: "Region", Value: credentials.region }] : [])];
  const metrics = await metricSum(cloudWatch(credentials, scope === "CLOUDFRONT" ? "us-east-1" : credentials.region), { namespace: "AWS/WAFV2", metric: "AllowedRequests", dimensions: dims, hours: 72 }).catch(() => null);
  const limits = tunedLimits({ samples, peakFiveMinute: metrics?.peak || 0 });
  if (!limits) {
    await patchProtection(project.id, { tuning: { ...(project.protection?.tuning || {}), status: "learning", checkedAt: new Date().toISOString(), note: "Not enough traffic yet; the default limits stay in place." } });
    return;
  }
  const previous = project.protection?.tuning?.limits;
  await patchProtection(project.id, { tuning: { limits: { global: limits.global, login: limits.login }, basis: limits.basis, status: "tuned", checkedAt: new Date().toISOString() } });
  const changed = !previous || Math.abs(previous.global - limits.global) / previous.global > 0.2 || Math.abs(previous.login - limits.login) / previous.login > 0.2;
  if (changed && !waf.underAttack) await applyProtection({ project: await freshProject(project.id), credentials, resources });
}

// ---------------------------------------------------------------- rotating admin door (#21)

async function rotateDoor({ project, credentials, resources, liveUrl, deploymentId }) {
  if (!securitySettings(project).adminDoor || project.securityTier !== "PROTECTED" || !project.protection?.waf) return;
  const door = { token: newDoorToken(), rotatedAt: new Date().toISOString() };
  await patchProtection(project.id, { door });
  await applyProtection({ project: await freshProject(project.id), credentials, resources });
  const link = `${String(liveUrl).replace(/\/$/, "")}${DOOR_PREFIX}${door.token}`;
  await raiseIncident({
    projectId: project.id, deploymentId, kind: "door.rotated", severity: "info", title: "New admin door link", detail: { rotatedAt: door.rotatedAt },
    dedupeKey: `door:${door.rotatedAt}`, forceAlert: true, extraText: `Admin door (valid until the next rotation): ${link}`,
  });
}

// ---------------------------------------------------------------- leak watch (#11)

async function leakWatch({ project, credentials, resources, liveUrl, deploymentId }) {
  const settings = securitySettings(project);
  if (!settings.leakWatch || project.siteOffline) return;
  const result = await runLeakWatch({ project, liveUrl, scanToken: ensureScanToken(project.protection), decoyMarkers: [project.protection?.honey?.accessKeyId].filter(Boolean) });
  const known = new Set(project.protection?.leaksReported || []);
  const fresh = result.findings.filter((item) => !known.has(item.id));
  await patchProtection(project.id, { leaksReported: result.findings.map((item) => item.id).slice(0, 200), leakWatch: { checked: result.checked, at: new Date().toISOString(), open: result.findings.length } });
  if (!fresh.length) return;
  await raiseIncident({
    projectId: project.id, deploymentId, kind: "leak.detected", severity: "critical",
    title: `Secret exposed on the live site: ${fresh[0].title}`,
    detail: { findings: fresh.map(({ title, location }) => ({ title, location })) },
    dedupeKey: `leak:${fresh.map((item) => item.id).sort().join("|")}`.slice(0, 180), dedupeMinutes: 24 * 60,
    respond: async (current) => {
      if (!securitySettings(current).leakAutoOffline) return ["Leak recorded; the site stays online (automatic offline is off)"];
      await takeOfflineNow({ project: current, credentials, resources });
      return ["Site taken offline (maintenance page) so the secret stops being served; bring it back from the Security page after rotating the secret"];
    },
  });
}

// ---------------------------------------------------------------- new CVEs via OSV (#8)

const OSV = "https://api.osv.dev/v1";
const severityOf = (vuln) => {
  const text = JSON.stringify([vuln.database_specific?.severity, vuln.affected?.map((item) => item.database_specific?.severity), vuln.severity?.map((item) => item.score)]).toUpperCase();
  if (/CRITICAL/.test(text)) return "critical";
  if (/HIGH/.test(text)) return "high";
  if (/MODERATE|MEDIUM/.test(text)) return "medium";
  return "medium";
};

export async function queryOsv(dependencies) {
  if (!dependencies?.length) return [];
  const found = [];
  for (let index = 0; index < dependencies.length; index += 500) {
    const batch = dependencies.slice(index, index + 500);
    const response = await axios.post(`${OSV}/querybatch`, { queries: batch.map((dep) => ({ package: { name: dep.name, ecosystem: dep.ecosystem }, version: dep.version })) }, { timeout: 30_000 });
    (response.data?.results || []).forEach((result, position) => {
      for (const vuln of result?.vulns || []) found.push({ id: vuln.id, package: batch[position] });
    });
  }
  return found;
}

async function cveWatch({ project, deploymentId }) {
  if (!securitySettings(project).cveWatch) return;
  const dependencies = project.protection?.dependencies || [];
  if (!dependencies.length) return;
  const vulns = await queryOsv(dependencies);
  const known = new Set(project.protection?.knownVulns || []);
  const baseline = !project.protection?.knownVulns;
  const fresh = vulns.filter((item) => !known.has(`${item.id}:${item.package.name}`));
  await patchProtection(project.id, { knownVulns: [...new Set(vulns.map((item) => `${item.id}:${item.package.name}`))].slice(0, 2000), cve: { checkedAt: new Date().toISOString(), open: vulns.length, packages: dependencies.length } });
  if (!fresh.length) return;
  const details = [];
  for (const item of fresh.slice(0, 15)) {
    const vuln = await axios.get(`${OSV}/vulns/${encodeURIComponent(item.id)}`, { timeout: 15_000 }).then((response) => response.data).catch(() => null);
    details.push({ id: item.id, package: `${item.package.name}@${item.package.version}`, ecosystem: item.package.ecosystem, summary: String(vuln?.summary || vuln?.details || "").slice(0, 200), severity: vuln ? severityOf(vuln) : "medium", aliases: (vuln?.aliases || []).slice(0, 3) });
  }
  const worst = details.some((item) => item.severity === "critical") ? "critical" : details.some((item) => item.severity === "high") ? "high" : "medium";
  await raiseIncident({
    projectId: project.id, deploymentId, kind: "cve.new", severity: baseline ? (worst === "critical" ? "high" : "medium") : worst,
    title: baseline ? `${fresh.length} known vulnerabilit${fresh.length === 1 ? "y" : "ies"} in your dependencies` : `New vulnerability published for ${details[0]?.package}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ""}`,
    detail: { vulnerabilities: details, total: fresh.length },
    dedupeKey: `cve:${fresh.map((item) => item.id).sort().join(",")}`.slice(0, 180), dedupeMinutes: 7 * 24 * 60,
  });
}

// ---------------------------------------------------------------- secrets pushed to git (#9)

export async function scanCommitsForSecrets({ owner, repo, branch, token, sinceSha }) {
  let github = axios.create({ baseURL: "https://api.github.com", timeout: 20_000, headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  let commits;
  try {
    commits = (await github.get(`/repos/${owner}/${repo}/commits`, { params: { sha: branch, per_page: 20 } })).data || [];
  } catch (error) {
    // An expired GitHub token must not stop monitoring public repositories.
    if (!token || error.response?.status !== 401) throw error;
    github = axios.create({ baseURL: "https://api.github.com", timeout: 20_000, headers: { Accept: "application/vnd.github+json" } });
    commits = (await github.get(`/repos/${owner}/${repo}/commits`, { params: { sha: branch, per_page: 20 } })).data || [];
  }
  if (!commits.length) return { headSha: sinceSha, findings: [] };
  const headSha = commits[0].sha;
  if (!sinceSha) return { headSha, findings: [], baseline: true };
  const index = commits.findIndex((commit) => commit.sha === sinceSha);
  const fresh = (index === -1 ? commits.slice(0, 10) : commits.slice(0, index)).slice(0, 10);
  const findings = [];
  for (const commit of fresh) {
    const detail = (await github.get(`/repos/${owner}/${repo}/commits/${commit.sha}`)).data;
    for (const file of detail.files || []) {
      if (file.status !== "removed" && isSensitiveFile(file.filename)) findings.push({ commit: commit.sha.slice(0, 7), author: detail.commit?.author?.name, file: file.filename, title: `Sensitive file committed: ${file.filename}` });
      for (const hit of secretsInPatch(file.patch || "")) findings.push({ commit: commit.sha.slice(0, 7), author: detail.commit?.author?.name, file: `${file.filename}:${hit.line}`, title: hit.title, severity: hit.severity });
    }
  }
  return { headSha, findings, scanned: fresh.length };
}

async function pushWatch({ project, deploymentId }) {
  if (!securitySettings(project).pushSecretWatch) return;
  const [owner, repo] = String(project.repoName || "").split("/");
  if (!owner || !repo) return;
  const account = await prisma.gitHubAccount.findUnique({ where: { userId: project.userId } });
  const token = account ? decryptSecret(account.accessToken) : null;
  const result = await scanCommitsForSecrets({ owner, repo, branch: project.branch, token, sinceSha: project.protection?.pushWatch?.headSha });
  await patchProtection(project.id, { pushWatch: { headSha: result.headSha, checkedAt: new Date().toISOString(), scanned: result.scanned || 0 } });
  if (!result.findings.length) return;
  await raiseIncident({
    projectId: project.id, deploymentId, kind: "secret.pushed", severity: "critical",
    title: `Secret pushed to ${project.repoName}: ${result.findings[0].title}`,
    detail: { findings: result.findings.slice(0, 20) },
    dedupeKey: `push:${result.headSha}`, dedupeMinutes: 7 * 24 * 60,
  });
}

// ---------------------------------------------------------------- denial-of-wallet guard (#19)

const PRICE = {
  albHour: 0.0225, lcuHour: 0.008, dataOutGb: 0.09, wafPerMillion: 0.6, wafAcl: 5, wafRule: 1,
  fargateVcpuHour: 0.04048, fargateGbHour: 0.004445, cloudfrontGb: 0.085, cloudfrontPer10k: 0.01, hoursPerMonth: 730,
};

/** Projected monthly cost from the last 24 hours of traffic. */
export function projectMonthlyCost({ requests24h = 0, bytes24h = 0, edgeRequests24h = 0, edgeBytes24h = 0, cpu = 0.5, memoryGb = 1, protectedTier = false, ruleCount = 9, hasAlb = true, managedDatabase = false }) {
  const gb = bytes24h / 1e9;
  const lcuPerHour = Math.max(gb / 24, requests24h / (24 * 3600 * 25));
  const fixed = (hasAlb ? PRICE.albHour * PRICE.hoursPerMonth + (cpu * PRICE.fargateVcpuHour + memoryGb * PRICE.fargateGbHour) * PRICE.hoursPerMonth : 0.05)
    + (protectedTier ? PRICE.wafAcl + PRICE.wafRule * ruleCount : 0)
    // db.t4g.micro on-demand + 20 GB gp3 storage
    + (managedDatabase ? 0.016 * PRICE.hoursPerMonth + 20 * 0.115 : 0);
  const variable = 30 * (
    (hasAlb ? lcuPerHour * 24 * PRICE.lcuHour + gb * PRICE.dataOutGb : 0)
    + (protectedTier ? (requests24h + edgeRequests24h) / 1e6 * PRICE.wafPerMillion : 0)
    + (edgeBytes24h / 1e9) * PRICE.cloudfrontGb + (edgeRequests24h / 10_000) * PRICE.cloudfrontPer10k
  );
  return { fixed: Math.round(fixed * 100) / 100, variable: Math.round(variable * 100) / 100, total: Math.round((fixed + variable) * 100) / 100 };
}

export async function estimateCost({ project, credentials, resources }) {
  const settings = securitySettings(project);
  let requests24h = 0;
  let bytes24h = 0;
  let edgeRequests24h = 0;
  let edgeBytes24h = 0;
  const regional = cloudWatch(credentials, credentials.region);
  if (resources?.loadBalancerArn) {
    const dimension = [{ Name: "LoadBalancer", Value: resources.loadBalancerArn.split(":loadbalancer/")[1] }];
    requests24h = (await metricSum(regional, { namespace: "AWS/ApplicationELB", metric: "RequestCount", dimensions: dimension, period: 3600 }).catch(() => ({ total: 0 }))).total;
    bytes24h = (await metricSum(regional, { namespace: "AWS/ApplicationELB", metric: "ProcessedBytes", dimensions: dimension, period: 3600 }).catch(() => ({ total: 0 }))).total;
  }
  const distributionId = resources?.edgeDistributionId || resources?.distributionId;
  if (distributionId) {
    const edge = cloudWatch(credentials, "us-east-1");
    const dimension = [{ Name: "DistributionId", Value: distributionId }, { Name: "Region", Value: "Global" }];
    edgeRequests24h = (await metricSum(edge, { namespace: "AWS/CloudFront", metric: "Requests", dimensions: dimension, period: 3600 }).catch(() => ({ total: 0 }))).total;
    edgeBytes24h = (await metricSum(edge, { namespace: "AWS/CloudFront", metric: "BytesDownloaded", dimensions: dimension, period: 3600 }).catch(() => ({ total: 0 }))).total;
  }
  const cpu = Number.parseFloat(project.cpu) || 0.5;
  const memoryGb = /MB/.test(project.memory || "") ? (Number.parseFloat(project.memory) || 512) / 1024 : Number.parseFloat(project.memory) || 1;
  const cost = projectMonthlyCost({ requests24h, bytes24h, edgeRequests24h, edgeBytes24h, cpu, memoryGb, protectedTier: project.securityTier === "PROTECTED" && Boolean(project.protection?.waf), ruleCount: project.protection?.waf?.ruleCount || 9, hasAlb: Boolean(resources?.loadBalancerArn), managedDatabase: Boolean(project.databaseConfig?.identifier) });
  return { ...cost, requests24h, bytes24h, edgeRequests24h, edgeBytes24h, budget: settings.walletBudgetUsd, at: new Date().toISOString(), note: resources?.loadBalancerArn || distributionId ? null : "S3 website hosting publishes no free traffic metrics; the estimate covers storage only." };
}

async function walletGuard({ project, credentials, resources, deploymentId }) {
  const cost = await estimateCost({ project, credentials, resources });
  await patchProtection(project.id, { wallet: cost });
  const budget = securitySettings(project).walletBudgetUsd;
  if (!budget || cost.total < budget * 0.8) return;
  const over = cost.total >= budget;
  await raiseIncident({
    projectId: project.id, deploymentId, kind: "wallet.budget", severity: over ? "high" : "medium",
    title: `${over ? "Over budget" : "Approaching budget"}: projected $${cost.total}/month vs your $${budget} budget`,
    detail: cost, dedupeKey: `wallet:${over ? "over" : "near"}`, dedupeMinutes: 12 * 60,
    respond: over ? async (current) => {
      const actions = [];
      if (current.securityTier === "PROTECTED" && current.protection?.waf && !current.protection.waf.underAttack && resources?.loadBalancerArn) {
        await setUnderAttackMode({ project: current, credentials, resources, enabled: true, autoMinutes: 120 });
        actions.push("Under Attack mode switched on to cut abusive traffic");
      }
      if (securitySettings(current).walletHardStop && cost.total >= budget * 1.5) {
        await takeOfflineNow({ project: current, credentials, resources });
        actions.push("Site taken offline: projected cost passed 150% of the budget (hard stop is on)");
      }
      return actions.length ? actions : ["Recorded; no automatic action configured for this tier"];
    } : null,
  });
}

// ---------------------------------------------------------------- health incidents (#6)

/** Called by the monitor after every probe. Raises site.down after 3 failures and site.recovered after. */
export async function recordHealth({ project, credentials, resources, deploymentId, healthy, error }) {
  const current = project.protection?.health || { failures: 0, down: false };
  if (healthy) {
    if (current.down) {
      await patchProtection(project.id, { health: { failures: 0, down: false, restarted: false } });
      await raiseIncident({ projectId: project.id, deploymentId, kind: "site.recovered", severity: "info", title: "Site is back up", detail: { downSince: current.downSince }, dedupeKey: `recovered:${current.downSince}` });
    } else if (current.failures) {
      await patchProtection(project.id, { health: { failures: 0, down: false } });
    }
    return;
  }
  const failures = (current.failures || 0) + 1;
  const goingDown = failures >= 3 && !current.down;
  await patchProtection(project.id, { health: { ...current, failures, down: current.down || goingDown, downSince: goingDown ? new Date().toISOString() : current.downSince } });
  if (!goingDown) return;
  await raiseIncident({
    projectId: project.id, deploymentId, kind: "site.down", severity: "high", title: "Site is down: 3 health checks failed in a row",
    detail: { error: String(error || "").slice(0, 300) }, dedupeKey: `down:${Math.floor(Date.now() / (30 * MINUTE))}`,
    respond: async () => {
      if (!resources?.serviceName || !resources?.clusterName || current.restarted) return ["Recorded; waiting for the site to recover"];
      await forceNewTasks({ credentials, resources });
      await patchProtection(project.id, (latest) => ({ health: { ...(latest.health || {}), restarted: true } }));
      return ["Restarted the app's containers once (fresh tasks from the same image)"];
    },
  });
}

// ---------------------------------------------------------------- orchestration

const TASKS = [
  { name: "sync", every: 10 * MINUTE, run: syncAndReport },
  { name: "attack", every: 10 * MINUTE, run: attackSpike },
  { name: "push", every: 10 * MINUTE, run: pushWatch },
  { name: "wallet", every: 60 * MINUTE, run: walletGuard },
  { name: "tuning", every: 6 * 60 * MINUTE, run: tuneRateLimits },
  { name: "leaks", every: 6 * 60 * MINUTE, run: leakWatch },
  { name: "cve", every: 24 * 60 * MINUTE, run: cveWatch },
  { name: "door", every: 24 * 60 * MINUTE, run: rotateDoor },
];

/** Runs whichever tasks are due. Never throws: one failing task must not stop the others. */
export async function runSecurityAutomation({ projectId, credentials, resources, liveUrl, deploymentId, only = null }) {
  const results = {};
  for (const task of TASKS) {
    if (only && !only.includes(task.name)) continue;
    const project = await freshProject(projectId);
    if (!project || (!only && !(await due(project, task.name, task.every)))) continue;
    if (task.name === "door" && !project.protection?.door?.rotatedAt) continue;
    if (task.name === "door" && Date.now() - Date.parse(project.protection.door.rotatedAt) < task.every && !only) {
      await markRun(projectId, task.name);
      continue;
    }
    await markRun(projectId, task.name);
    try {
      await task.run({ project, credentials, resources, liveUrl, deploymentId });
      results[task.name] = "ok";
    } catch (error) {
      results[task.name] = `error: ${String(error.message).slice(0, 160)}`;
      console.warn(`[SECURITY:${task.name}] ${project.name}: ${error.message}`);
    }
  }
  return results;
}
