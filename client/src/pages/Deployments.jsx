import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  AlertCircle, CheckCircle2, Clock3, GitCommitHorizontal, GitCompare, GitPullRequest, History, Loader2, RefreshCw, Rocket, RotateCcw, Terminal, Trash2, Undo2, User, Zap,
} from "lucide-react";
import { getDeploymentHistory, restoreDeploymentVersion } from "../services/api";
import StageBar from "../components/StageBar";
import { Notice, PageHeader } from "../components/ui";
import { buttonClass, formatDuration, timeAgo } from "../utils/format";

const LIVE = ["LIVE", "ROLLED_BACK"];
const WORKING = ["QUEUED", "BUILDING", "PUSHING", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "ROLLING_BACK", "DESTROYING"];

const TRIGGERS = {
  push: { label: "Git push", icon: Zap, className: "bg-[#2563EB]/10 text-[#1D4ED8]" },
  preview: { label: "PR preview", icon: GitPullRequest, className: "bg-[#7C4DBA]/10 text-[#6D28D9]" },
  manual: { label: "Manual", icon: User, className: "bg-[#8C7667]/10 text-[#5E4C3E]" },
};

function kindOf(row) {
  if (!row.target && /DESTROY/.test(row.status)) return "teardown";
  if (row.restoredFromId) return "restore";
  return row.trigger || "manual";
}

function StatusIcon({ status }) {
  if (LIVE.includes(status)) return <CheckCircle2 className="h-4 w-4 text-[#2E6B4F]" />;
  if (["FAILED", "DESTROY_FAILED"].includes(status)) return <AlertCircle className="h-4 w-4 text-[#9E2A2B]" />;
  if (WORKING.includes(status)) return <Loader2 className="h-4 w-4 animate-spin text-[#2563EB]" />;
  if (status === "DESTROYED") return <Trash2 className="h-4 w-4 text-[#8C7667]" />;
  return <Clock3 className="h-4 w-4 text-[#8C7667]" />;
}

const STATUS_TEXT = { LIVE: "Live", ROLLED_BACK: "Live (restored)", FAILED: "Failed", CANCELLED: "Cancelled", DESTROYED: "Removed", DESTROY_FAILED: "Teardown failed", ROLLING_BACK: "Restoring", DESTROYING: "Removing" };

/** What changed compared with the previous deployment of the same project. */
function differences(row) {
  const previous = row.previous;
  if (!previous) return [];
  const notes = [];
  if (row.commitSha && previous.commitSha && row.commitSha !== previous.commitSha) notes.push("new code");
  if (row.commitSha && previous.commitSha && row.commitSha === previous.commitSha) notes.push("same code");
  if (row.configVersion !== null && previous.configVersion !== null && row.configVersion !== previous.configVersion) notes.push("settings changed");
  if (row.target && previous.target && row.target !== previous.target) notes.push("different target");
  if (row.durationMs && previous.durationMs) {
    const delta = row.durationMs - previous.durationMs;
    if (Math.abs(delta) >= 10_000) notes.push(`${formatDuration(Math.abs(delta))} ${delta > 0 ? "slower" : "faster"}`);
  }
  return notes;
}

/** Every deployment across all projects as a timeline: who, what code, how long each step took, what changed. */
export default function Deployments() {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [projectFilter, setProjectFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [restoring, setRestoring] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = async () => {
    try {
      setRows(await getDeploymentHistory({ limit: 200 }));
      setError(null);
    } catch (loadError) {
      setError(loadError.response?.data?.message || "Could not load deployment history.");
    }
  };

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(load, 15_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  const projects = useMemo(() => [...new Map((rows || []).map((row) => [row.project.id, row.project])).values()], [rows]);
  // The version each project is serving now: its newest live deployment.
  const current = useMemo(() => {
    const map = new Map();
    for (const row of rows || []) if (LIVE.includes(row.status) && !map.has(row.projectId)) map.set(row.projectId, row.id);
    return map;
  }, [rows]);

  const visible = (rows || []).filter((row) => (projectFilter === "all" || row.projectId === projectFilter)
    && (statusFilter === "all"
      || (statusFilter === "live" && LIVE.includes(row.status))
      || (statusFilter === "failed" && ["FAILED", "DESTROY_FAILED"].includes(row.status))
      || (statusFilter === "working" && WORKING.includes(row.status))));

  // Group by day for the timeline headings.
  const groups = [];
  for (const row of visible) {
    const day = new Date(row.createdAt).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    if (groups.at(-1)?.day !== day) groups.push({ day, rows: [] });
    groups.at(-1).rows.push(row);
  }

  const restore = async (row) => {
    if (!window.confirm(`Put the version from ${new Date(row.createdAt).toLocaleString()} back live for ${row.project.name}?`)) return;
    setRestoring(row.id);
    try {
      const result = await restoreDeploymentVersion(row.id);
      setNotice({ kind: "success", text: result.message });
      load();
    } catch (restoreError) {
      setNotice({ kind: "error", text: restoreError.response?.data?.message || "Could not restore that version." });
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        icon={History}
        title="Deployments"
        subtitle="Every deploy, newest first: who started it, which code went out, how long each step took, and what changed from the one before."
        actions={<button type="button" onClick={load} className={buttonClass.secondary}><RefreshCw className="h-3.5 w-3.5" /> Refresh</button>}
      />

      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}

      <div className="flex flex-col gap-2 sm:flex-row">
        <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} className="h-10 rounded-xl border border-[#DCD0C3] bg-white px-3 text-xs font-semibold text-[#362217] outline-none">
          <option value="all">All projects</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <div className="flex rounded-xl border border-[#DCD0C3] bg-white p-0.5">
          {[["all", "All"], ["live", "Live"], ["working", "In progress"], ["failed", "Failed"]].map(([value, label]) => (
            <button key={value} type="button" onClick={() => setStatusFilter(value)} className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold transition ${statusFilter === value ? "bg-[#9E5D2D] text-white" : "text-[#5E4C3E] hover:bg-[#FAF6F0]"}`}>{label}</button>
          ))}
        </div>
      </div>

      {!rows && !error && <div className="flex flex-col gap-3">{[0, 1, 2, 3].map((key) => <div key={key} className="skeleton h-24" />)}</div>}

      {rows && !visible.length && (
        <div className="flex flex-col items-center gap-3 rounded-3xl border border-[#EAE1D5] bg-white py-14 text-center">
          <Rocket className="h-10 w-10 text-[#D6C4B4]" />
          <p className="text-sm font-bold text-[#362217]">{rows.length ? "Nothing matches these filters" : "No deployments yet"}</p>
          <p className="max-w-sm text-xs text-[#5E4C3E]">{rows.length ? "Try another project or status." : "Deploy a site and its history shows up here."}</p>
          {!rows.length && <Link to="/dashboard/new" className={buttonClass.primary}><Rocket className="h-3.5 w-3.5" /> Deploy a new site</Link>}
        </div>
      )}

      {groups.map((group) => (
        <section key={group.day} className="flex flex-col gap-3">
          <h3 className="text-xs font-bold uppercase tracking-wide text-[#8C7667]">{group.day}</h3>
          <ol className="relative flex flex-col gap-3 border-l-2 border-[#EADFCF] pl-5">
            {group.rows.map((row) => {
              const kind = kindOf(row);
              const trigger = kind === "restore"
                ? { label: "Restore", icon: Undo2, className: "bg-[#0E8A7A]/10 text-[#0E8A7A]" }
                : kind === "teardown" ? { label: "Teardown", icon: Trash2, className: "bg-[#8C7667]/10 text-[#5E4C3E]" } : TRIGGERS[kind] || TRIGGERS.manual;
              const TriggerIcon = trigger.icon;
              const notes = differences(row);
              const isCurrent = current.get(row.projectId) === row.id;
              const canRestore = LIVE.includes(row.status) && !isCurrent && current.has(row.projectId) && kind !== "teardown";
              return (
                <li key={row.id} className="relative">
                  <span className="absolute -left-[29px] top-4 flex h-4 w-4 items-center justify-center rounded-full bg-white ring-2 ring-[#EADFCF]"><StatusIcon status={row.status} /></span>
                  <article className="lift flex flex-col gap-3 rounded-3xl border border-[#EAE1D5] bg-white p-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link to={`/project/${row.projectId}/deploy`} className="text-sm font-bold text-[#362217] hover:text-[#9E5D2D]">{row.project.name}</Link>
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${trigger.className}`}><TriggerIcon className="h-3 w-3" /> {trigger.label}</span>
                          <span className="text-[11px] font-semibold text-[#5E4C3E]">{STATUS_TEXT[row.status] || row.status.toLowerCase().replaceAll("_", " ")}</span>
                          {isCurrent && <span className="rounded-full bg-[#2E6B4F] px-2 py-0.5 text-[10px] font-bold text-white">Serving now</span>}
                        </div>
                        {row.commitSha ? (
                          <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-[#362217]">
                            <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-[#8C7667]" />
                            <a href={`https://github.com/${row.project.repoName}/commit/${row.commitSha}`} target="_blank" rel="noreferrer" className="font-mono text-[#9E5D2D] hover:underline">{row.commitSha.slice(0, 7)}</a>
                            <span className="truncate">{row.commitMessage?.split("\n")[0]}</span>
                          </p>
                        ) : kind !== "teardown" && <p className="mt-1 text-xs text-[#8C7667]">Commit not recorded (deployed before history tracking)</p>}
                        <p className="mt-1 text-[11px] text-[#8C7667]">
                          {row.by} · {timeAgo(row.createdAt)}{row.durationMs ? ` · took ${formatDuration(row.durationMs)}` : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        {canRestore && (
                          <button type="button" disabled={restoring === row.id} onClick={() => restore(row)} className={buttonClass.secondary}>
                            {restoring === row.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Restore this version
                          </button>
                        )}
                        <button type="button" onClick={() => navigate(`/project/${row.projectId}/deploy?deploymentId=${encodeURIComponent(row.id)}`)} className={buttonClass.secondary}><Terminal className="h-3.5 w-3.5" /> Logs</button>
                      </div>
                    </div>

                    {row.stageTimings?.length > 0 && <StageBar timings={row.stageTimings} endAt={row.completedAt} failedStage={row.status === "FAILED" ? row.currentStep : null} showLegend />}

                    {row.error && row.status === "FAILED" && <p className="rounded-xl bg-[#9E2A2B]/5 px-3 py-2 text-[11px] text-[#9E2A2B]">{row.error}</p>}

                    {(notes.length > 0 || row.compareUrl) && (
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className="font-semibold text-[#8C7667]">vs previous:</span>
                        {notes.map((note) => <span key={note} className="rounded-full border border-[#EADFCF] bg-[#FAF8F5] px-2 py-0.5 text-[#5E4C3E]">{note}</span>)}
                        {row.compareUrl && <a href={row.compareUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-[#9E5D2D] hover:underline"><GitCompare className="h-3.5 w-3.5" /> Code changes</a>}
                      </div>
                    )}
                  </article>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
