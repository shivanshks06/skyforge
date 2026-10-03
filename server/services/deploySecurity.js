import fs from "node:fs";
import path from "node:path";
import prisma from "../config/db.js";
import { emitDeploymentLog } from "./logsService.js";
import { decryptObjectValues } from "./secretService.js";
import { collectSourceFiles } from "./envScanner.js";
import { findAppRoot } from "./buildPlanner.js";
import { scanCodeSecurity } from "./securityScanner.js";
import { getImageScanFindings } from "./ecrService.js";
import { resourceNames, setTaskRolePolicy } from "./ecsService.js";
import { egressPortsFor, codePermissionsFor, dependenciesFor, attackSurfaceFor, diffAttackSurface } from "./securityPolicy.js";
import { securitySettings, patchProtection } from "./securityService.js";
import { raiseIncident } from "./incidentService.js";

/**
 * Security work inside the deployment pipeline:
 *   - code analysis: outbound ports, AWS permissions, dependencies, attack surface (+ diff);
 *   - security gate before any traffic reaches the new version (code findings, image CVEs);
 *   - container hardening options for ECS (outbound firewall, read-only filesystem);
 *   - least-privilege task-role policy generated from the code.
 */

const gateError = (message) => Object.assign(new Error(message), { code: "SECURITY_GATE_BLOCKED" });

// Files the source scan skips (it reads code), but whose presence matters to the security features.
function findFilesNamed(root, names, depth = 5) {
  const found = [];
  const walk = (dir, level, prefix) => {
    if (level > depth || found.length > 20) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!/^(node_modules|\.git|vendor|venv|\.venv|__pycache__|dist|build|target)$/.test(entry.name)) walk(path.join(dir, entry.name), level + 1, `${prefix}${entry.name}/`);
      } else if (names.some((name) => (name instanceof RegExp ? name.test(entry.name) : name === entry.name.toLowerCase()))) {
        let content = "";
        try {
          const full = path.join(dir, entry.name);
          if (fs.statSync(full).size <= 8 * 1024 * 1024) content = fs.readFileSync(full, "utf-8");
        } catch {}
        found.push({ path: `${prefix}${entry.name}`, content });
      }
    }
  };
  walk(root, 0, "");
  return found;
}

export function collectProjectSource(sourceDir) {
  try {
    const root = findAppRoot(sourceDir);
    const files = collectSourceFiles(root);
    // robots.txt (decoy decisions) and dependency manifests (CVE watch, outbound ports).
    const extra = findFilesNamed(root, ["robots.txt", "package-lock.json", "poetry.lock", "pipfile.lock", "go.mod", "gemfile.lock", "composer.lock", "cargo.lock", /^requirements[\w.-]*\.txt$/i]);
    return [...files.filter((file) => !extra.some((item) => item.path === file.path && item.content)), ...extra];
  } catch {
    return [];
  }
}

export async function analyzeSource({ project, sourceFiles, deploymentId, port = null }) {
  const log = (message, level = "info") => emitDeploymentLog(deploymentId, { stage: "BUILDING", message, level });
  const envValues = decryptObjectValues(project.envConfig || {});
  const egressPorts = egressPortsFor({ sourceFiles, envValues });
  const dependencies = dependenciesFor(sourceFiles);
  const permissions = codePermissionsFor({ sourceFiles, envValues });
  const surface = attackSurfaceFor({ sourceFiles, envKeys: Object.keys(envValues), dependencies, port: port || project.port, egressPorts, framework: project.framework, permissions: permissions.actions });
  const previous = project.protection?.surface || null;
  const diff = diffAttackSurface(previous, surface);
  await patchProtection(project.id, (current) => ({
    egressPorts,
    dependencies,
    codePermissions: { actions: permissions.actions, policy: permissions.policy, evidence: permissions.evidence, scopedBuckets: permissions.scopedBuckets || [], generatedAt: new Date().toISOString() },
    surface,
    surfaceDiff: { ...diff, deploymentId, at: new Date().toISOString() },
    surfaceHistory: [{ deploymentId, at: new Date().toISOString(), risk: diff.risk, highlights: diff.highlights }, ...(current.surfaceHistory || [])].slice(0, 15),
  }));
  log(`[SECURITY] Code analysis: ${surface.routes.length} route(s), ${dependencies.length} package(s), outbound ports ${egressPorts.join(", ")}, ${permissions.actions.length} AWS action(s) used by the code.`);
  if (!diff.first && diff.highlights.length) {
    log(`[SURFACE] Attack surface changed since the last deployment (${diff.risk} risk): ${diff.highlights.join("; ")}.`, diff.risk === "high" ? "warn" : "info");
    if (["high", "medium"].includes(diff.risk)) {
      await raiseIncident({
        projectId: project.id, deploymentId, kind: "surface.changed", severity: diff.risk === "high" ? "medium" : "low",
        title: `Deployment changed the attack surface: ${diff.highlights[0]}`, detail: { highlights: diff.highlights, changes: diff.changes },
        dedupeKey: `surface:${deploymentId}`,
      }).catch(() => {});
    }
  }
  return { egressPorts, dependencies, permissions, surface, diff };
}

/** Blocks (or warns about) critical code findings before anything is built or deployed. */
export async function codeGate({ project, sourceFiles, deploymentId }) {
  const mode = securitySettings(project).securityGate;
  if (mode === "off" || !sourceFiles.length) return;
  const critical = scanCodeSecurity(sourceFiles).filter((item) => item.severity === "critical");
  const log = (message, level) => emitDeploymentLog(deploymentId, { stage: "BUILDING", message, level });
  if (!critical.length) {
    log("[GATE] Security gate passed: no critical findings in the code.", "success");
    return;
  }
  const list = critical.slice(0, 5).map((item) => `${item.title} (${item.location})`).join("; ");
  if (mode === "warn") {
    log(`[GATE] Security gate warning (deploying anyway; set the gate to "block" to stop such deploys): ${list}`, "warn");
    return;
  }
  await raiseIncident({ projectId: project.id, deploymentId, kind: "gate.blocked", severity: "high", title: "Deployment blocked by the security gate", detail: { findings: critical.slice(0, 10).map(({ title, location }) => ({ title, location })) }, dedupeKey: `gate:${deploymentId}` }).catch(() => {});
  throw gateError(`Security gate blocked the deployment: ${list}. Fix these (the Security page can open fix pull requests) or set the gate to "warn".`);
}

/** Waits for the ECR scan of the pushed image and blocks on critical CVEs in "block" mode. */
export async function imageGate({ project, credentials, repositoryName, imageDigest, deploymentId }) {
  const mode = securitySettings(project).securityGate;
  if (mode === "off") return null;
  const log = (message, level) => emitDeploymentLog(deploymentId, { stage: "PUSHING", message, level });
  log("[GATE] Waiting for the container image vulnerability scan (up to 90 seconds)...", "info");
  const scan = await getImageScanFindings({ credentials, repositoryName, imageDigest, waitMs: 90_000 }).catch((error) => ({ status: "ERROR", detail: error.message }));
  if (scan.status !== "COMPLETE") {
    log(`[GATE] Image scan not available yet (${scan.status}); continuing. It will appear in the security report.`, "warn");
    return scan;
  }
  const critical = scan.counts?.CRITICAL || 0;
  if (!critical) {
    log(`[GATE] Image scan passed: 0 critical, ${scan.counts?.HIGH || 0} high vulnerabilities.`, "success");
    return scan;
  }
  const names = (scan.top || []).filter((cve) => cve.severity === "CRITICAL").slice(0, 3).map((cve) => `${cve.name} (${cve.package})`).join(", ");
  if (mode === "warn") {
    log(`[GATE] Image has ${critical} critical vulnerabilities (${names}); deploying anyway because the gate is set to warn.`, "warn");
    return scan;
  }
  await raiseIncident({ projectId: project.id, deploymentId, kind: "gate.blocked", severity: "high", title: `Deployment blocked: ${critical} critical vulnerabilities in the image`, detail: { counts: scan.counts, top: scan.top?.slice(0, 10) }, dedupeKey: `gate-image:${deploymentId}` }).catch(() => {});
  throw gateError(`Security gate blocked the deployment before it received traffic: the image has ${critical} critical vulnerabilities (${names}). Update the base image/dependencies or set the gate to "warn".`);
}

export function hardeningFor(project, analysis) {
  const settings = securitySettings(project);
  return {
    egressPorts: settings.egressLockdown ? analysis?.egressPorts || [80, 443] : null,
    readOnlyRoot: settings.readOnlyRoot,
  };
}

/** Puts the generated least-privilege policy on the task role (or removes it when the setting is off). */
export async function syncCodePermissions({ project, credentials, analysis, deploymentId }) {
  const settings = securitySettings(project);
  const roleName = resourceNames(project).taskRoleName;
  const policy = settings.applyCodePermissions ? analysis?.permissions?.policy : null;
  await setTaskRolePolicy({ credentials, roleName, policy });
  if (policy) emitDeploymentLog(deploymentId, { stage: "DEPLOYING", message: `[IAM] Task role granted only the AWS actions your code uses: ${analysis.permissions.actions.join(", ")}.`, level: "info" });
  await patchProtection(project.id, (current) => ({ codePermissions: { ...(current.codePermissions || {}), applied: Boolean(policy) } }));
}

export async function refreshProject(projectId) {
  return prisma.project.findUnique({ where: { id: projectId } });
}
