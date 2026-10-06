import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, Moon, Trash2 } from "lucide-react";

// One meaning per colour across the app: green live, blue working, red failed, amber offline, grey idle.
const STYLES = {
  live: { label: "Live", icon: CheckCircle2, className: "bg-[#2E6B4F]/10 text-[#2E6B4F] border-[#2E6B4F]/25", dot: "bg-[#2E6B4F]" },
  working: { label: "Deploying", icon: Loader2, className: "bg-[#2563EB]/10 text-[#1D4ED8] border-[#2563EB]/25", dot: "bg-[#2563EB]", spin: true },
  failed: { label: "Failed", icon: AlertTriangle, className: "bg-[#9E2A2B]/10 text-[#9E2A2B] border-[#9E2A2B]/25", dot: "bg-[#9E2A2B]" },
  offline: { label: "Offline", icon: Moon, className: "bg-amber-500/10 text-amber-700 border-amber-500/30", dot: "bg-amber-500" },
  destroyed: { label: "Destroyed", icon: Trash2, className: "bg-[#8C7667]/10 text-[#5E4C3E] border-[#8C7667]/25", dot: "bg-[#A39284]" },
  idle: { label: "Not deployed", icon: CircleDashed, className: "bg-[#FAF8F5] text-[#8C7667] border-[#EAE1D5]", dot: "bg-[#C9BBAE]" },
};


export default function StatusBadge({ state, label, size = "sm" }) {
  const style = STYLES[state] || STYLES.idle;
  const Icon = style.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border font-semibold ${size === "xs" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-0.5 text-[11px]"} ${style.className}`}>
      <Icon className={`h-3 w-3 ${style.spin ? "animate-spin" : ""}`} />
      {label || style.label}
    </span>
  );
}

export function StatusDot({ state }) {
  const style = STYLES[state] || STYLES.idle;
  return (
    <span className="relative flex h-2.5 w-2.5">
      {state === "live" && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-40 ${style.dot}`} />}
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${style.dot}`} />
    </span>
  );
}
