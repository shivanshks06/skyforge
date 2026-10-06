import { useId, useState } from "react";
import { formatValue } from "../utils/format";

const formatTime = (iso, spanHours) => {
  const date = new Date(iso);
  return spanHours > 24
    ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
};


/** A small area chart with a hover read-out. points: [{ t, v }]. */
export function AreaChart({ points = [], unit, color = "#9E5D2D", height = 120, max = null }) {
  const id = useId().replace(/:/g, "");
  const [hover, setHover] = useState(null);
  if (!points.length) {
    return <div style={{ height }} className="flex items-center justify-center rounded-xl border border-dashed border-[#EADFCF] text-[11px] text-[#A39284]">No data in this period yet</div>;
  }
  const width = 600;
  const top = max ?? Math.max(...points.map((point) => point.v), unit === "%" ? 10 : 1);
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const coords = points.map((point, index) => [index * step, height - 6 - (point.v / (top || 1)) * (height - 14)]);
  const line = coords.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const spanHours = (new Date(points.at(-1).t) - new Date(points[0].t)) / 3600_000;
  const active = hover !== null ? points[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block w-full"
        style={{ height }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const index = Math.round(((event.clientX - box.left) / box.width) * (points.length - 1));
          setHover(Math.max(0, Math.min(points.length - 1, index)));
        }}
      >
        <defs>
          <linearGradient id={`fill-${id}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#fill-${id})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {hover !== null && <line x1={coords[hover][0]} x2={coords[hover][0]} y1="0" y2={height} stroke={color} strokeOpacity="0.4" vectorEffect="non-scaling-stroke" strokeDasharray="3 3" />}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-[#A39284]">
        <span>{formatTime(points[0].t, spanHours)}</span>
        {active && <span className="font-semibold text-[#362217]">{formatValue(active.v, unit)} · {formatTime(active.t, spanHours)}</span>}
        <span>{formatTime(points.at(-1).t, spanHours)}</span>
      </div>
    </div>
  );
}

/** Vertical bars (e.g. daily cost). bars: [{ label, value }]. */
export function BarChart({ bars = [], unit, color = "#9E5D2D", height = 140 }) {
  const [hover, setHover] = useState(null);
  const top = Math.max(...bars.map((bar) => bar.value), 0.01);
  if (!bars.length) return <div style={{ height }} className="flex items-center justify-center text-[11px] text-[#A39284]">No data yet</div>;
  return (
    <div>
      <div className="flex items-end gap-[3px]" style={{ height }} onMouseLeave={() => setHover(null)}>
        {bars.map((bar, index) => (
          <div
            key={bar.label}
            onMouseEnter={() => setHover(index)}
            className="flex-1 rounded-t-md transition-opacity"
            style={{ height: `${Math.max(2, (bar.value / top) * 100)}%`, background: color, opacity: hover === null || hover === index ? 1 : 0.45 }}
            title={`${bar.label}: ${formatValue(bar.value, unit)}`}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-[#A39284]">
        <span>{bars[0].label}</span>
        {hover !== null && <span className="font-semibold text-[#362217]">{bars[hover].label}: {formatValue(bars[hover].value, unit)}</span>}
        <span>{bars.at(-1).label}</span>
      </div>
    </div>
  );
}

/** One bar per day, coloured by uptime (grey when there were no checks). */
export function UptimeStrip({ days = [], height = 32 }) {
  const colour = (uptime) => (uptime === null ? "rgba(140, 118, 103, 0.28)" : uptime >= 99.9 ? "#2E9E6B" : uptime >= 99 ? "#7CB342" : uptime >= 95 ? "#E0A13E" : "#C2412D");
  return (
    <div className="flex items-stretch gap-[2px]" style={{ height }}>
      {days.map((day) => (
        <div
          key={day.day}
          className="flex-1 rounded-[3px] transition-transform hover:scale-y-110"
          style={{ background: colour(day.uptime) }}
          title={`${day.day}: ${day.uptime === null ? "no checks" : `${day.uptime}% up${day.failures ? `, ${day.failures} failed check(s)` : ""}`}`}
        />
      ))}
    </div>
  );
}
