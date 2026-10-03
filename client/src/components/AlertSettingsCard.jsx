import { useEffect, useState } from "react";
import { Bell, CheckCircle2, Mail, MessageSquare, Send, Webhook } from "lucide-react";
import Card from "./Card";
import Button from "./Button";
import Input from "./Input";
import { getAlertSettings, saveAlertSettings, sendTestAlert } from "../services/api";

const CHANNELS = [
  {
    id: "email",
    label: "Email (SMTP)",
    icon: Mail,
    help: "Any SMTP server. Gmail: smtp.gmail.com, port 587, your address, and an App Password (Google account → Security → App passwords).",
    fields: [
      ["host", "SMTP host", "smtp.gmail.com"],
      ["port", "Port", "587"],
      ["user", "Username", "you@gmail.com"],
      ["password", "Password / app password", "", "password"],
      ["from", "From address (optional)", "you@gmail.com"],
      ["to", "Send alerts to (comma separated)", "you@gmail.com"],
    ],
  },
  {
    id: "slack",
    label: "Slack",
    icon: MessageSquare,
    help: "Slack → Apps → Incoming Webhooks → Add to a channel, then paste the webhook URL.",
    fields: [["webhookUrl", "Incoming webhook URL", "https://hooks.slack.com/services/...", "password"]],
  },
  {
    id: "discord",
    label: "Discord",
    icon: MessageSquare,
    help: "Channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.",
    fields: [["webhookUrl", "Webhook URL", "https://discord.com/api/webhooks/...", "password"]],
  },
  {
    id: "telegram",
    label: "Telegram",
    icon: Send,
    help: "Message @BotFather → /newbot to get a token. Send your bot a message, then open api.telegram.org/bot<token>/getUpdates to find your chat id.",
    fields: [
      ["botToken", "Bot token", "123456789:AA...", "password"],
      ["chatId", "Chat ID", "-1001234567890"],
    ],
  },
  {
    id: "webhook",
    label: "Custom webhook",
    icon: Webhook,
    help: "SkyForge POSTs JSON to this HTTPS URL. With a signing secret, the x-skyforge-signature header carries an HMAC-SHA256 of the body.",
    fields: [
      ["url", "HTTPS URL", "https://example.com/skyforge-alerts", "password"],
      ["secret", "Signing secret (optional)", "", "password"],
    ],
  },
];

export default function AlertSettingsCard() {
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    getAlertSettings()
      .then((data) => setSettings(data.settings))
      .catch(() => setNotice({ type: "error", message: "Could not load alert settings." }));
  }, []);

  const update = (channel, field, value) => setSettings((current) => ({ ...current, [channel]: { ...current[channel], [field]: value } }));

  const save = async () => {
    setBusy("save");
    try {
      const result = await saveAlertSettings(settings);
      setSettings(result.settings);
      setNotice({ type: "success", message: result.message });
    } catch (err) {
      setNotice({ type: "error", message: err.response?.data?.message || "Saving failed." });
    } finally {
      setBusy(null);
    }
  };

  const test = async (channel) => {
    setBusy(`test-${channel}`);
    try {
      const result = await sendTestAlert(channel);
      setNotice({ type: "success", message: result.message });
    } catch (err) {
      setNotice({ type: "error", message: err.response?.data?.message || "The test alert failed." });
    } finally {
      setBusy(null);
    }
  };

  if (!settings) {
    return (
      <Card glow={false} className="bg-white border border-[#EAE1D5] text-sm text-[#8C7667]">
        {notice?.message || "Loading alert channels..."}
      </Card>
    );
  }

  return (
    <Card glow={false} className="flex flex-col gap-5 bg-white border border-[#EAE1D5]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#EADFCF] pb-3">
        <div className="flex items-center gap-3">
          <span className="p-2 rounded-xl bg-[#9E5D2D]/10 text-[#9E5D2D]"><Bell className="h-5 w-5" /></span>
          <div>
            <h3 className="text-base font-bold text-[#362217]">Security alerts</h3>
            <p className="text-xs text-[#5E4C3E]">Every enabled channel receives incidents from all your projects: attacks, leaked secrets, new CVEs, downtime, budget, and what SkyForge did about them.</p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-[#5E4C3E]">
          Alert me from
          <select value={settings.minSeverity} onChange={(event) => setSettings({ ...settings, minSeverity: event.target.value })} className="rounded-lg border border-[#EADFCF] bg-white px-2 py-1 text-xs text-[#362217]">
            {["info", "low", "medium", "high", "critical"].map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
          severity up
        </label>
      </div>

      {notice && (
        <div className={`rounded-xl border px-3 py-2 text-xs ${notice.type === "error" ? "bg-[#FDF2F2] border-[#9E2A2B]/30 text-[#9E2A2B]" : "bg-[#F1F8F4] border-[#2E6B4F]/30 text-[#2E6B4F]"}`}>{notice.message}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {CHANNELS.map((channel) => {
          const value = settings[channel.id] || { enabled: false };
          const Icon = channel.icon;
          return (
            <div key={channel.id} className={`rounded-2xl border p-4 flex flex-col gap-3 ${value.enabled ? "border-[#9E5D2D]/40 bg-[#FFFBF6]" : "border-[#EADFCF] bg-[#FAF8F5]"}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm font-bold text-[#362217]"><Icon className="h-4 w-4 text-[#9E5D2D]" /> {channel.label}</span>
                <label className="flex items-center gap-2 text-xs font-semibold text-[#5E4C3E] cursor-pointer">
                  <input type="checkbox" checked={Boolean(value.enabled)} onChange={(event) => update(channel.id, "enabled", event.target.checked)} className="accent-[#9E5D2D]" />
                  Enabled
                </label>
              </div>
              <p className="text-[11px] text-[#8C7667]">{channel.help}</p>
              {value.enabled && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {channel.fields.map(([field, label, placeholder, type]) => (
                    <Input
                      key={field}
                      label={label}
                      type={type || "text"}
                      placeholder={placeholder}
                      value={value[field] ?? ""}
                      autoComplete="off"
                      onChange={(event) => update(channel.id, field, field === "port" ? event.target.value.replace(/\D/g, "") : event.target.value)}
                      containerClassName={channel.fields.length === 1 || field === "to" || field === "url" ? "sm:col-span-2" : ""}
                    />
                  ))}
                </div>
              )}
              {value.enabled && (
                <Button size="sm" variant="outline" icon={CheckCircle2} loading={busy === `test-${channel.id}`} disabled={Boolean(busy)} onClick={() => test(channel.id)} className="self-start">
                  Send test (save first)
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex justify-end">
        <Button icon={CheckCircle2} loading={busy === "save"} disabled={Boolean(busy)} onClick={save}>Save alert channels</Button>
      </div>
    </Card>
  );
}
