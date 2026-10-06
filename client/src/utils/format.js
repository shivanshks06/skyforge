// Shared formatting helpers and button styles for the dashboard pages.

export const buttonClass = {
  primary: "inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#9E5D2D] px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-[#8A5026] disabled:cursor-not-allowed disabled:opacity-60",
  secondary: "inline-flex items-center justify-center gap-1.5 rounded-xl border border-[#DCD0C3] bg-white px-3.5 py-2 text-xs font-semibold text-[#5E4C3E] transition hover:bg-[#FAF6F0] disabled:cursor-not-allowed disabled:opacity-60",
  danger: "inline-flex items-center justify-center gap-1.5 rounded-xl border border-[#9E2A2B]/40 bg-[#9E2A2B]/5 px-3.5 py-2 text-xs font-semibold text-[#9E2A2B] transition hover:bg-[#9E2A2B]/10 disabled:cursor-not-allowed disabled:opacity-60",
};

/** "3 minutes ago" style relative time. */
export function timeAgo(iso) {
  if (!iso) return "";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatValue(value, unit) {
  if (value === null || value === undefined) return "—";
  if (unit === "%") return `${Math.round(value * 10) / 10}%`;
  if (unit === "ms") return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
  if (unit === "bytes") {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = value;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
  }
  if (unit === "usd") return `$${Number(value).toFixed(2)}`;
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value * 100) / 100);
}
