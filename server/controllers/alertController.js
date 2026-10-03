import prisma from "../config/db.js";
import { normalizeAlertSettings, publicAlertSettings, sendAlert, ALERT_CHANNELS } from "../services/alertService.js";
import { PLAYBOOK } from "../services/incidentService.js";

const fail = (res, error, fallback) => {
  if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
  console.error(`[ALERTS] ${fallback}:`, error.message);
  return res.status(500).json({ message: fallback });
};

export const getAlertSettings = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { alertSettings: true } });
    return res.json({ settings: publicAlertSettings(user?.alertSettings || {}), channels: ALERT_CHANNELS });
  } catch (error) {
    return fail(res, error, "Failed to load alert settings");
  }
};

export const updateAlertSettings = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { alertSettings: true } });
    const settings = await normalizeAlertSettings(req.body?.settings || {}, user?.alertSettings || {});
    await prisma.user.update({ where: { id: req.user.id }, data: { alertSettings: settings } });
    return res.json({ message: "Alert channels saved.", settings: publicAlertSettings(settings) });
  } catch (error) {
    return fail(res, error, "Failed to save alert settings");
  }
};

export const sendTestAlert = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { alertSettings: true, name: true } });
    const channel = ALERT_CHANNELS.includes(req.body?.channel) ? req.body.channel : undefined;
    const results = await sendAlert(user?.alertSettings, {
      kind: "test", severity: "info", title: "SkyForge test alert", projectName: "All projects",
      summary: PLAYBOOK.test.summary, actions: [], nextSteps: [], at: new Date().toISOString(),
    }, { force: true, only: channel });
    if (!results.length) return res.status(400).json({ message: "No alert channel is enabled. Fill in a channel and save first." });
    const failed = results.filter((result) => !result.ok);
    return res.status(failed.length === results.length ? 502 : 200).json({
      message: failed.length ? `Sent to ${results.length - failed.length}/${results.length} channel(s). ${failed.map((result) => `${result.channel}: ${result.error}`).join("; ")}` : `Test alert delivered to ${results.map((result) => result.channel).join(", ")}.`,
      results,
    });
  } catch (error) {
    return fail(res, error, "Failed to send the test alert");
  }
};
