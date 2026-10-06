import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Clock3, ExternalLink, Loader2, Moon, Wrench } from "lucide-react";
import { getPublicStatus } from "../services/api";
import { UptimeStrip } from "../components/Charts";
import { timeAgo } from "../utils/format";

const STATES = {
  operational: { label: "All systems operational", icon: CheckCircle2, className: "bg-[#2E6B4F] text-white" },
  down: { label: "The site is having problems", icon: AlertTriangle, className: "bg-[#B3261E] text-white" },
  updating: { label: "An update is being rolled out", icon: Loader2, className: "bg-[#2563EB] text-white", spin: true },
  maintenance: { label: "Down for maintenance", icon: Wrench, className: "bg-[#B26A00] text-white" },
  offline: { label: "The site is offline", icon: Moon, className: "bg-[#5E4C3E] text-white" },
  unknown: { label: "Status unknown", icon: Clock3, className: "bg-[#8C7667] text-white" },
};

const percent = (value) => (value === null || value === undefined ? "—" : `${value}%`);

/** Public page: is the site up, and how reliable has it been. No login. */
export default function StatusPage() {
  const { slug } = useParams();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => getPublicStatus(slug)
      .then((data) => !cancelled && (setStatus(data), setError(null)))
      .catch((loadError) => !cancelled && setError(loadError.response?.status === 404 ? "This status page doesn't exist or has been switched off." : "Status is temporarily unavailable."));
    load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [slug]);

  useEffect(() => {
    if (status?.name) document.title = `${status.name} status`;
  }, [status?.name]);

  const state = STATES[status?.state] || STATES.unknown;
  const Icon = state.icon;

  return (
    <div className="app-bg min-h-screen bg-[#FAF8F5] px-4 py-10 text-[#362217]">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        {error && <div className="rounded-3xl border border-[#EAE1D5] bg-white p-8 text-center text-sm text-[#5E4C3E]">{error}</div>}
        {!status && !error && <div className="skeleton h-40" />}
        {status && (
          <>
            <header className="flex flex-col gap-1">
              <h1 className="text-3xl font-bold">{status.name}</h1>
              {status.url && <a href={status.url} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1 font-mono text-xs text-[#9E5D2D] hover:underline">{status.url.replace(/^https?:\/\//, "")} <ExternalLink className="h-3 w-3" /></a>}
            </header>

            <div className={`keep-colors flex items-center gap-3 rounded-3xl px-6 py-5 shadow-sm ${state.className}`}>
              <Icon className={`h-7 w-7 ${state.spin ? "animate-spin" : ""}`} />
              <div>
                <p className="text-lg font-bold">{state.label}</p>
                <p className="text-xs opacity-85">{status.checkedAt ? `${status.state === "operational" || status.state === "down" ? "Checked" : "Updated"} ${timeAgo(status.checkedAt)}` : "Not checked yet"}{status.latencyMs ? ` · responded in ${status.latencyMs} ms` : ""}</p>
              </div>
            </div>

            <section className="rounded-3xl border border-[#EAE1D5] bg-white p-6">
              <div className="mb-4 flex items-end justify-between">
                <h2 className="text-sm font-bold">Uptime, last 90 days</h2>
                <span className="text-2xl font-bold text-[#2E6B4F]">{percent(status.uptime.quarter)}</span>
              </div>
              <UptimeStrip days={status.history} height={40} />
              <div className="mt-1.5 flex justify-between text-[10px] text-[#A39284]"><span>90 days ago</span><span>Today</span></div>
              <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[["24 hours", status.uptime.day], ["7 days", status.uptime.week], ["30 days", status.uptime.month], ["90 days", status.uptime.quarter]].map(([label, value]) => (
                  <div key={label} className="rounded-2xl bg-[#FAF8F5] p-3 text-center">
                    <dt className="text-[11px] text-[#8C7667]">{label}</dt>
                    <dd className="text-base font-bold">{percent(value)}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="rounded-3xl border border-[#EAE1D5] bg-white p-6">
              <h2 className="mb-3 text-sm font-bold">Recent problems</h2>
              {status.incidents.length ? (
                <ul className="flex flex-col gap-2">
                  {status.incidents.map((incident) => (
                    <li key={incident.day} className="flex items-center justify-between rounded-2xl bg-[#FAF8F5] px-4 py-2.5 text-xs">
                      <span className="font-semibold">{new Date(`${incident.day}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>
                      <span className="text-[#5E4C3E]">{incident.failedChecks} failed check{incident.failedChecks === 1 ? "" : "s"} · {percent(incident.uptime)} up</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-xs text-[#5E4C3E]">No problems recorded in the last 90 days.</p>}
            </section>

            <footer className="text-center text-[11px] text-[#A39284]">Checked every minute · Powered by SkyForge</footer>
          </>
        )}
      </div>
    </div>
  );
}
