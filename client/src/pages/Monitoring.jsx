import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Activity, ArrowDownToLine, Download, ExternalLink, Pause, Play, RefreshCw, Rocket, Search, Terminal } from "lucide-react";
import { getProjectAppLogs, getProjectById, getProjectMetrics, getProjectUptime } from "../services/api";
import { AreaChart, UptimeStrip } from "../components/Charts";
import { Notice, PageHeader, Panel } from "../components/ui";
import { buttonClass, formatValue } from "../utils/format";

const RANGES = [["1h", "1 hour"], ["6h", "6 hours"], ["24h", "24 hours"], ["7d", "7 days"]];
const COLORS = { cpu: "#9E5D2D", memory: "#7C4DBA", requests: "#2563EB", latency: "#0E8A7A", errors5xx: "#C2412D", errors4xx: "#D97706", edgeRequests: "#2563EB", edgeErrors: "#C2412D", edgeBytes: "#0E8A7A" };
const LEVEL_CLASS = { error: "text-[#F87171]", warn: "text-[#FBBF24]", info: "text-[#E5DED6]" };
const MAX_LINES = 2000;

function MetricCard({ series }) {
  const { summary, unit } = series;
  const headline = summary.total !== null && unit === "count" ? `${formatValue(summary.total, unit)} total` : `${formatValue(summary.latest, unit)} now`;
  return (
    <div className="rounded-3xl border border-[#EAE1D5] bg-white p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-xs font-bold text-[#5E4C3E]">{series.label}</span>
        <span className="text-sm font-bold text-[#362217]">{headline}</span>
      </div>
      <AreaChart points={series.points} unit={unit} color={COLORS[series.id] || "#9E5D2D"} max={unit === "%" && series.id !== "edgeErrors" ? 100 : null} height={96} />
      <div className="mt-2 flex gap-3 text-[10px] text-[#8C7667]">
        <span>Peak {formatValue(summary.peak, unit)}</span>
        <span>Average {formatValue(summary.average, unit)}</span>
      </div>
    </div>
  );
}

/** Logs and metrics of the running site. */
export default function Monitoring() {
  const { id } = useParams();
  const [project, setProject] = useState(null);
  const [range, setRange] = useState("1h");
  const [metrics, setMetrics] = useState(null);
  const [metricsError, setMetricsError] = useState(null);
  const [uptime, setUptime] = useState([]);
  const [loading, setLoading] = useState(true);

  const [logs, setLogs] = useState([]);
  const [logsError, setLogsError] = useState(null);
  const [live, setLive] = useState(true);
  const [filter, setFilter] = useState("");
  const [appliedFilter, setAppliedFilter] = useState("");
  const [level, setLevel] = useState("all");
  const [follow, setFollow] = useState(true);
  const terminal = useRef(null);
  const cursor = useRef(null);

  const loadMetrics = useCallback(async () => {
    try {
      setMetrics(await getProjectMetrics(id, range));
      setMetricsError(null);
    } catch (error) {
      setMetricsError(error.response?.data?.message || "Could not load metrics.");
    } finally {
      setLoading(false);
    }
  }, [id, range]);

  useEffect(() => {
    getProjectById(id).then(setProject).catch(() => {});
    getProjectUptime(id).then((data) => setUptime(data.history || [])).catch(() => {});
  }, [id]);

  useEffect(() => {
    const first = window.setTimeout(() => void loadMetrics(), 0);
    const timer = window.setInterval(loadMetrics, 60_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [loadMetrics]);

  // Logs: the first load covers the last 30 minutes, then each poll asks only for newer lines.
  useEffect(() => {
    let cancelled = false;
    cursor.current = null;
    const poll = async () => {
      try {
        const first = !cursor.current;
        const result = await getProjectAppLogs(id, first ? { minutes: 30, filter: appliedFilter } : { after: cursor.current, filter: appliedFilter });
        if (cancelled) return;
        if (result.events.length) cursor.current = result.events.at(-1).timestamp;
        // The first answer replaces whatever an earlier search showed; later ones append.
        if (first) setLogs(result.events.slice(-MAX_LINES));
        else if (result.events.length) setLogs((current) => [...current, ...result.events].slice(-MAX_LINES));
        setLogsError(null);
      } catch (error) {
        if (!cancelled) setLogsError(error.response?.data?.message || "Could not load app logs.");
      }
    };
    poll();
    const timer = live ? window.setInterval(poll, 5000) : null;
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [id, live, appliedFilter]);

  const visible = useMemo(() => logs.filter((line) => level === "all" || line.level === level || (level === "warn" && line.level === "error")), [logs, level]);

  useEffect(() => {
    if (follow && terminal.current) terminal.current.scrollTop = terminal.current.scrollHeight;
  }, [visible, follow]);

  const download = () => {
    const text = visible.map((line) => `${line.time} ${line.message}`).join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: `${project?.name || "app"}-logs.txt` });
    link.click();
    URL.revokeObjectURL(url);
  };

  const uptimePercent = useMemo(() => {
    const checks = uptime.reduce((sum, day) => sum + day.checks, 0);
    const failures = uptime.reduce((sum, day) => sum + day.failures, 0);
    return checks ? Math.round(((checks - failures) / checks) * 10000) / 100 : null;
  }, [uptime]);

  const notLive = metricsError && /isn't live/.test(metricsError);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        back
        icon={Activity}
        title={`Monitoring${project ? ` · ${project.name}` : ""}`}
        subtitle="What your site is doing right now: traffic, speed, errors and the app's own log output."
        actions={!notLive && (
          <>
            {metrics?.liveUrl && <a href={metrics.liveUrl} target="_blank" rel="noreferrer" className={buttonClass.secondary}><ExternalLink className="h-3.5 w-3.5" /> Open site</a>}
            <div className="flex rounded-xl border border-[#DCD0C3] bg-white p-0.5">
              {RANGES.map(([value, label]) => (
                <button key={value} type="button" onClick={() => setRange(value)} className={`rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition ${range === value ? "bg-[#9E5D2D] text-white" : "text-[#5E4C3E] hover:bg-[#FAF6F0]"}`}>{label}</button>
              ))}
            </div>
            <button type="button" onClick={loadMetrics} className={buttonClass.secondary} aria-label="Refresh metrics"><RefreshCw className="h-3.5 w-3.5" /></button>
          </>
        )}
      />

      {notLive ? (
        <Panel>
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <Activity className="h-10 w-10 text-[#D6C4B4]" />
            <p className="text-sm font-bold text-[#362217]">Nothing to monitor yet</p>
            <p className="max-w-md text-xs text-[#5E4C3E]">Charts and logs appear here once the site is live. Deploy it, and SkyForge starts collecting them automatically.</p>
            <Link to={`/project/${id}/deploy`} className={buttonClass.primary}><Rocket className="h-3.5 w-3.5" /> Go to deploy</Link>
          </div>
        </Panel>
      ) : (
        <>
          {metrics?.offline && <Notice kind="warn">The site is offline (maintenance page). Traffic and container metrics stay flat until you bring it back online.</Notice>}
          {metricsError && <Notice kind="error">{metricsError}</Notice>}

          <Panel
            title="Uptime"
            description="One bar per day from SkyForge's once-a-minute health check. Hover a bar for details."
            actions={<span className="text-2xl font-bold text-[#2E6B4F]">{uptimePercent === null ? "—" : `${uptimePercent}%`}</span>}
          >
            <UptimeStrip days={uptime} />
            <div className="mt-1.5 flex justify-between text-[10px] text-[#A39284]"><span>30 days ago</span><span>Today</span></div>
          </Panel>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {loading && !metrics && Array.from({ length: 6 }).map((_, index) => <div key={index} className="skeleton h-44" />)}
            {metrics?.series?.map((series) => <MetricCard key={series.id} series={series} />)}
          </div>
        </>
      )}

      {!notLive && <Panel
        icon={Terminal}
        title="App logs"
        description="Everything the app prints (console.log, print, errors), straight from CloudWatch. New lines appear every 5 seconds while Live is on."
        actions={(
          <>
            <button type="button" onClick={() => setLive((value) => !value)} className={live ? buttonClass.primary : buttonClass.secondary}>
              {live ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />} {live ? "Live" : "Paused"}
            </button>
            <button type="button" onClick={download} disabled={!visible.length} className={buttonClass.secondary}><Download className="h-3.5 w-3.5" /> Download</button>
          </>
        )}
      >
        <div className="mb-3 flex flex-col gap-2 sm:flex-row">
          <form
            className="flex flex-1 items-center gap-2 rounded-xl border border-[#DCD0C3] bg-white px-3"
            onSubmit={(event) => {
              event.preventDefault();
              setAppliedFilter(filter.trim());
            }}
          >
            <Search className="h-4 w-4 text-[#A39284]" />
            <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search the logs (press Enter)" className="h-9 w-full bg-transparent text-xs text-[#362217] outline-none placeholder:text-[#A39284]" />
            {appliedFilter && <button type="button" onClick={() => { setFilter(""); setAppliedFilter(""); }} className="text-[11px] font-semibold text-[#9E5D2D]">Clear</button>}
          </form>
          <div className="flex rounded-xl border border-[#DCD0C3] bg-white p-0.5">
            {[["all", "All"], ["warn", "Warnings"], ["error", "Errors"]].map(([value, label]) => (
              <button key={value} type="button" onClick={() => setLevel(value)} className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold transition ${level === value ? "bg-[#362217] text-white" : "text-[#5E4C3E] hover:bg-[#FAF6F0]"}`}>{label}</button>
            ))}
          </div>
        </div>

        {logsError && !/isn't live/.test(logsError) && <Notice kind="warn" className="mb-3">{logsError}</Notice>}
        <div className="relative">
          <div
            ref={terminal}
            onScroll={(event) => {
              const box = event.currentTarget;
              setFollow(box.scrollHeight - box.scrollTop - box.clientHeight < 40);
            }}
            className="keep-colors h-[420px] overflow-auto rounded-2xl bg-[#1A1411] p-4 font-mono text-[11.5px] leading-relaxed"
          >
            {!visible.length && <p className="text-[#8C7F73]">{logsError && /isn't live|no server/.test(logsError) ? logsError : appliedFilter ? `No lines matching "${appliedFilter}" yet.` : "Waiting for the app to print something…"}</p>}
            {visible.map((line) => (
              <div key={line.id} className="flex gap-3 whitespace-pre-wrap break-all">
                <span className="shrink-0 select-none text-[#7D6F64]">{new Date(line.time).toLocaleTimeString()}</span>
                <span className={LEVEL_CLASS[line.level]}>{line.message}</span>
              </div>
            ))}
          </div>
          {!follow && (
            <button
              type="button"
              onClick={() => {
                setFollow(true);
                if (terminal.current) terminal.current.scrollTop = terminal.current.scrollHeight;
              }}
              className="absolute bottom-4 right-4 inline-flex items-center gap-1 rounded-full bg-[#9E5D2D] px-3 py-1.5 text-[11px] font-semibold text-white shadow-lg"
            >
              <ArrowDownToLine className="h-3.5 w-3.5" /> Jump to latest
            </button>
          )}
        </div>
        <p className="mt-2 text-[10px] text-[#A39284]">{visible.length} line{visible.length === 1 ? "" : "s"} shown · logs are kept for 7 days in CloudWatch</p>
      </Panel>}
    </div>
  );
}
