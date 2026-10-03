import net from "node:net";
import dns from "node:dns/promises";
import axios from "axios";
import nodemailer from "nodemailer";
import { encryptSecret, decryptSecret, isEncryptedSecret, MASKED_SECRET } from "./secretService.js";
import { isPrivateAddress } from "./healthService.js";

/**
 * Alert channels. Each user configures any of: Email (SMTP), Slack, Discord, Telegram, and a
 * generic JSON webhook. Every configured channel receives every alert at or above the user's
 * minimum severity. Secret fields (webhook URLs, bot token, SMTP password) are stored encrypted.
 */

export const SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"];
const SECRET_FIELDS = { email: ["password"], slack: ["webhookUrl"], discord: ["webhookUrl"], telegram: ["botToken"], webhook: ["url", "secret"] };
const CHANNELS = Object.keys(SECRET_FIELDS);
const SEVERITY_ICON = { critical: "🚨", high: "🔴", medium: "🟠", low: "🔵", info: "ℹ️" };
const SEVERITY_COLOR = { critical: 0x9e2a2b, high: 0xea580c, medium: 0xd97706, low: 0x3b7a75, info: 0x8c7667 };

const validationError = (message) => Object.assign(new Error(message), { statusCode: 400 });
const text = (value, max = 500) => String(value ?? "").trim().slice(0, max);

async function assertPublicHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw validationError(`${label} is not a valid URL.`);
  }
  if (url.protocol !== "https:") throw validationError(`${label} must use https://.`);
  if (url.username || url.password) throw validationError(`${label} must not contain credentials.`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw validationError(`${label}: ${host} does not resolve.`);
  if (addresses.some(({ address }) => isPrivateAddress(address))) throw validationError(`${label} must point to a public address.`);
  return url;
}

/** Validates and normalises submitted channel settings, keeping stored secrets when the client sends the mask. */
export async function normalizeAlertSettings(input = {}, previous = {}) {
  const result = { minSeverity: SEVERITY_ORDER.includes(input.minSeverity) ? input.minSeverity : previous.minSeverity || "medium" };
  for (const channel of CHANNELS) {
    const submitted = input[channel];
    if (!submitted || submitted.enabled === false && !Object.keys(submitted).some((key) => key !== "enabled" && submitted[key])) {
      result[channel] = { enabled: false };
      continue;
    }
    const merged = { ...submitted };
    for (const field of SECRET_FIELDS[channel]) {
      if (merged[field] === MASKED_SECRET || merged[field] === undefined) merged[field] = previous[channel]?.[field] ? decryptSecret(previous[channel][field]) : "";
    }
    const enabled = submitted.enabled !== false;
    if (channel === "email") {
      const port = Number(merged.port || 587);
      if (enabled && (!merged.host || !merged.to)) throw validationError("Email needs an SMTP host and a recipient address.");
      if (merged.to && !String(merged.to).split(",").every((address) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.trim()))) throw validationError("Email recipients must be valid addresses (comma separated).");
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw validationError("SMTP port must be between 1 and 65535.");
      result.email = { enabled, host: text(merged.host, 255), port, secure: merged.secure === true || port === 465, user: text(merged.user, 255), password: text(merged.password, 500), from: text(merged.from || merged.user, 255), to: text(merged.to, 1000) };
    } else if (channel === "slack") {
      if (enabled && !/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/.test(merged.webhookUrl || "")) throw validationError("Slack needs an incoming webhook URL (https://hooks.slack.com/services/...).");
      result.slack = { enabled, webhookUrl: text(merged.webhookUrl, 500) };
    } else if (channel === "discord") {
      if (enabled && !/^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(merged.webhookUrl || "")) throw validationError("Discord needs a channel webhook URL (https://discord.com/api/webhooks/...).");
      result.discord = { enabled, webhookUrl: text(merged.webhookUrl, 500) };
    } else if (channel === "telegram") {
      if (enabled && !/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(merged.botToken || "")) throw validationError("Telegram needs a bot token from @BotFather (looks like 123456:ABC...).");
      if (enabled && !/^(-?\d{3,}|@[A-Za-z0-9_]{4,})$/.test(String(merged.chatId || ""))) throw validationError("Telegram needs a chat ID (a number, or @channelname).");
      result.telegram = { enabled, botToken: text(merged.botToken, 200), chatId: text(merged.chatId, 100) };
    } else if (channel === "webhook") {
      if (enabled) await assertPublicHttpsUrl(merged.url, "Webhook URL");
      result.webhook = { enabled, url: text(merged.url, 1000), secret: text(merged.secret, 200) };
    }
    for (const field of SECRET_FIELDS[channel]) {
      if (result[channel][field]) result[channel][field] = encryptSecret(result[channel][field]);
    }
  }
  return result;
}

/** Settings safe to return to the browser: secrets replaced with the mask. */
export function publicAlertSettings(settings = {}) {
  const result = { minSeverity: settings.minSeverity || "medium" };
  for (const channel of CHANNELS) {
    const value = { enabled: false, ...(settings[channel] || {}) };
    for (const field of SECRET_FIELDS[channel]) if (value[field]) value[field] = MASKED_SECRET;
    result[channel] = value;
  }
  return result;
}

const secret = (value) => (value && isEncryptedSecret(value) ? decryptSecret(value) : value || "");

export function formatAlert(alert) {
  const icon = SEVERITY_ICON[alert.severity] || "";
  const lines = [
    `${icon} [${String(alert.severity).toUpperCase()}] ${alert.title}`,
    `Project: ${alert.projectName}`,
    alert.summary ? `\n${alert.summary}` : "",
    alert.actions?.length ? `\nSkyForge already did:\n${alert.actions.map((action) => `• ${action}`).join("\n")}` : "",
    alert.nextSteps?.length ? `\nWhat you should do:\n${alert.nextSteps.map((step) => `• ${step}`).join("\n")}` : "",
    alert.link ? `\n${alert.link}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

const SENDERS = {
  async email(config, alert, body) {
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.user ? { auth: { user: config.user, pass: secret(config.password) } } : {}),
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
    });
    await transport.sendMail({ from: config.from || config.user, to: config.to, subject: `[SkyForge ${alert.severity.toUpperCase()}] ${alert.title}`.slice(0, 200), text: body });
  },
  async slack(config, _alert, body) {
    await axios.post(secret(config.webhookUrl), { text: body }, { timeout: 10_000 });
  },
  async discord(config, alert, body) {
    await axios.post(secret(config.webhookUrl), {
      username: "SkyForge",
      embeds: [{ title: alert.title.slice(0, 256), description: body.slice(0, 4000), color: SEVERITY_COLOR[alert.severity] ?? 0, timestamp: new Date().toISOString() }],
    }, { timeout: 10_000 });
  },
  async telegram(config, _alert, body) {
    await axios.post(`https://api.telegram.org/bot${secret(config.botToken)}/sendMessage`, { chat_id: config.chatId, text: body.slice(0, 4000), disable_web_page_preview: true }, { timeout: 10_000 });
  },
  async webhook(config, alert, body) {
    const url = await assertPublicHttpsUrl(secret(config.url), "Webhook URL");
    const payload = { source: "skyforge", ...alert, text: body };
    const headers = { "content-type": "application/json" };
    const key = secret(config.secret);
    if (key) {
      const crypto = await import("node:crypto");
      headers["x-skyforge-signature"] = `sha256=${crypto.createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex")}`;
    }
    await axios.post(url.toString(), payload, { timeout: 10_000, headers, maxRedirects: 0 });
  },
};

const describeError = (error) => {
  const status = error.response?.status;
  const detail = error.response?.data?.description || error.response?.data?.message || error.message;
  return `${status ? `HTTP ${status}: ` : ""}${String(detail).slice(0, 200)}`;
};

/**
 * Sends one alert to every enabled channel. Returns [{ channel, ok, error? }].
 * `force` ignores the minimum severity (used for test alerts).
 */
export async function sendAlert(settings, alert, { force = false, only } = {}) {
  if (!settings) return [];
  const minimum = SEVERITY_ORDER.indexOf(settings.minSeverity || "medium");
  if (!force && SEVERITY_ORDER.indexOf(alert.severity) < minimum) return [];
  const body = formatAlert(alert);
  const targets = CHANNELS.filter((channel) => settings[channel]?.enabled && (!only || only === channel));
  return Promise.all(targets.map(async (channel) => {
    try {
      await SENDERS[channel](settings[channel], alert, body);
      return { channel, ok: true };
    } catch (error) {
      return { channel, ok: false, error: describeError(error) };
    }
  }));
}

export const ALERT_CHANNELS = CHANNELS;
