import { GoogleGenAI } from "@google/genai";
import prisma from "../config/db.js";
import { sendAlert } from "./alertService.js";
import { AI_MODEL } from "./aiPlanner.js";
import { emitDeploymentLog } from "./logsService.js";

/**
 * Incident engine. Every security signal (canary/honey key used, attack spike, site down, leaked
 * secret, new CVE, secret pushed to git, budget exceeded, ...) becomes a SecurityEvent:
 *   1. de-duplicated (the same signal is not reported twice within its window);
 *   2. automatic response, when the project allows it (Under Attack mode, bans, restart, offline);
 *   3. a plain-language summary (Gemini when configured, otherwise a written playbook);
 *   4. delivered to every alert channel the owner configured.
 */

export const PLAYBOOK = {
  "canary.used": {
    summary: "The canary AWS key planted inside your container was used. Nothing legitimate reads it, so someone obtained your container's environment variables (debug page, SSRF, leaked image or logs).",
    nextSteps: ["Rotate every secret on the Environment page and redeploy", "Check the app for debug pages, SSRF and file-read bugs", "Review CloudWatch logs around the time of use"],
  },
  "honey.used": {
    summary: "Someone downloaded a decoy secrets file (fake .env or AWS credentials) from your site and tried the key inside it. The key has no permissions and your real secrets were never in that file.",
    nextSteps: ["No secrets leaked; no action is required", "Keep the Protected tier on so these scanners stay banned"],
  },
  "decoy.taken": {
    summary: "Attackers requested a decoy secrets file. They received fake credentials that alert SkyForge when used, and their IPs were banned for 24 hours.",
    nextSteps: ["No action required; review the banned IPs on the Security page"],
  },
  "ip.banned": {
    summary: "Scanners probed honeypot paths that only attackers request and were banned for 24 hours. Their IPs are also shared with your other protected projects.",
    nextSteps: ["No action required"],
  },
  "attack.spike": {
    summary: "The firewall is blocking an unusual volume of malicious requests.",
    nextSteps: ["Watch the attack dashboard", "Under Attack mode switches off automatically once traffic is calm"],
  },
  "attack.calm": {
    summary: "Malicious traffic has returned to normal and automatic Under Attack mode was switched off.",
    nextSteps: [],
  },
  "site.down": {
    summary: "The site stopped answering health checks.",
    nextSteps: ["Check the application logs in the deployment console", "Roll back if the problem started with a deployment"],
  },
  "site.recovered": { summary: "The site is answering health checks again.", nextSteps: [] },
  "leak.detected": {
    summary: "A secret value or credential is visible in the site's public pages or JavaScript.",
    nextSteps: ["Rotate the exposed secret immediately", "Keep server-side secrets out of frontend build variables"],
  },
  "secret.pushed": {
    summary: "A credential was pushed to the repository. Bots scrape public pushes within minutes.",
    nextSteps: ["Revoke and rotate the credential now", "Remove it from git history (git filter-repo) and store it on the Environment page"],
  },
  "cve.new": {
    summary: "A newly published vulnerability affects a package your app uses.",
    nextSteps: ["Upgrade the affected package and redeploy"],
  },
  "surface.changed": {
    summary: "This deployment changed the app's attack surface (new admin, debug or upload routes, new AWS permissions, or new outbound ports).",
    nextSteps: ["Confirm the new routes are protected by authentication"],
  },
  "wallet.budget": {
    summary: "Traffic costs are projected to exceed your monthly budget (possible denial-of-wallet attack).",
    nextSteps: ["Check the attack dashboard", "Raise the budget if the traffic is legitimate"],
  },
  "gate.blocked": {
    summary: "The security gate stopped a deployment before it received traffic.",
    nextSteps: ["Fix the findings listed and deploy again, or switch the gate to warn"],
  },
  "door.rotated": {
    summary: "The secret admin door link was rotated. The previous link no longer works.",
    nextSteps: ["Use the new link below to reach the admin area"],
  },
  "redteam.findings": {
    summary: "The AI red-team rehearsal found weaknesses in the live site.",
    nextSteps: ["Review the findings on the Security page"],
  },
  test: { summary: "This is a test alert from SkyForge. Your alert channel works.", nextSteps: [] },
};

async function aiSummary(event, project) {
  if (!process.env.GEMINI_API_KEY || ["test", "ip.banned", "door.rotated", "site.recovered", "attack.calm"].includes(event.kind)) return null;
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const prompt = `You are a security incident responder writing an alert for a small web team.
Write 2-4 short plain-English sentences: what happened, how serious it is, and the single most important next step.
Do not use markdown. Do not invent facts that are not in the data.

Project: ${project.name} (${project.framework || "web app"})
Incident: ${event.title}
Severity: ${event.severity}
Data: ${JSON.stringify(event.detail || {}).slice(0, 2500)}
Automatic actions already taken: ${(event.actions || []).join("; ") || "none"}`;
    const response = await ai.models.generateContent({ model: AI_MODEL, contents: prompt, config: { temperature: 0.2, maxOutputTokens: 300 } });
    const text = String(response?.text || "").trim();
    return text && text.length < 1500 ? text : null;
  } catch {
    return null;
  }
}

function appUrl(projectId) {
  const origin = String(process.env.CLIENT_URL || process.env.FRONTEND_URL || "").split(",")[0].trim().replace(/\/$/, "");
  return origin ? `${origin}/project/${projectId}/security` : null;
}

/**
 * Records an incident, runs `respond` (automatic actions, returns strings), and alerts the owner.
 * Returns the stored SecurityEvent, or null when it duplicates a recent one.
 */
export async function raiseIncident({ projectId, kind, severity, title, detail = {}, dedupeKey = null, dedupeMinutes = 60, respond = null, deploymentId = null, forceAlert = false, extraText = null }) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { user: { select: { alertSettings: true } } } });
  if (!project) return null;
  const key = dedupeKey || kind;
  const recent = await prisma.securityEvent.findFirst({
    where: { projectId, dedupeKey: key, createdAt: { gt: new Date(Date.now() - dedupeMinutes * 60_000) } },
    select: { id: true },
  });
  if (recent) return null;

  const autoResponse = project.protection?.settings?.autoResponse !== false;
  const actions = [];
  if (respond && autoResponse) {
    try {
      actions.push(...((await respond(project)) || []).filter(Boolean));
    } catch (error) {
      actions.push(`Automatic response failed: ${String(error.message).slice(0, 160)}`);
    }
  }
  const playbook = PLAYBOOK[kind] || { summary: "", nextSteps: [] };
  const event = { kind, severity, title, detail, actions };
  const summary = (await aiSummary(event, project)) || playbook.summary;
  const stored = await prisma.securityEvent.create({
    data: { projectId, kind, severity, title: title.slice(0, 300), summary, detail, actions, dedupeKey: key },
  });
  const alerts = await sendAlert(project.user?.alertSettings, {
    id: stored.id,
    kind,
    severity,
    title,
    projectName: project.name,
    projectId,
    summary: extraText ? `${summary}\n\n${extraText}` : summary,
    actions,
    nextSteps: playbook.nextSteps,
    link: appUrl(projectId),
    at: stored.createdAt.toISOString(),
  }, { force: forceAlert }).catch((error) => [{ channel: "all", ok: false, error: error.message }]);
  if (alerts.length) await prisma.securityEvent.update({ where: { id: stored.id }, data: { alerts } }).catch(() => {});
  if (deploymentId) {
    emitDeploymentLog(deploymentId, { stage: "SECURITY", message: `[INCIDENT] ${title}${actions.length ? ` — SkyForge: ${actions.join("; ")}` : ""}`, level: ["critical", "high"].includes(severity) ? "error" : "warn" });
  }
  return { ...stored, alerts };
}

export async function listIncidents(projectId, { limit = 50 } = {}) {
  return prisma.securityEvent.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: limit });
}
