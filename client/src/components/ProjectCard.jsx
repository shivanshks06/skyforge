import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Activity, AlertTriangle, ChevronDown, ExternalLink, FileCode, GitBranch, GitPullRequest, Globe, Loader2, Rocket, Server, Settings2, Shield, SlidersHorizontal, Terminal, Trash2, Zap } from "lucide-react";
import StatusBadge from "./StatusBadge";
import { projectState } from "../utils/projectState";

const Chip = ({ children }) => <span className="rounded-full border border-[#EADFCF] bg-[#FAF8F5] px-2.5 py-0.5 text-[11px] font-medium text-[#5E4C3E]">{children}</span>;

/** A project at a glance: what it is, whether it is live, and the one thing to do next. */
export default function ProjectCard({ project, onDelete }) {
  const navigate = useNavigate();
  const [details, setDetails] = useState(false);
  const state = projectState(project);
  const domain = project.customDomain?.status === "ACTIVE" ? `https://${project.customDomain.domain}` : null;
  const liveUrl = state === "live" ? domain || project.latestDeployment?.liveUrl : null;
  const previews = project.previews || [];
  const base = `/project/${project.id}`;

  const primary = {
    live: liveUrl ? { label: "Open site", icon: ExternalLink, href: liveUrl } : { label: "Open console", icon: Terminal, to: `${base}/deploy` },
    working: { label: "View progress", icon: Loader2, to: `${base}/deploy`, spin: true },
    failed: { label: "See what went wrong", icon: AlertTriangle, to: `${base}/deploy`, danger: true },
    offline: { label: "Bring online", icon: Rocket, to: `${base}/security` },
  }[state] || (project.deploymentTarget
    ? { label: "Deploy", icon: Rocket, to: `${base}/deploy` }
    : { label: "Choose target & deploy", icon: Rocket, to: `${base}/infrastructure` });

  const PrimaryIcon = primary.icon;
  const primaryClass = `inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold shadow-sm transition ${primary.danger ? "border border-[#9E2A2B]/40 bg-[#9E2A2B]/5 text-[#9E2A2B] hover:bg-[#9E2A2B]/10" : "bg-[#9E5D2D] text-white hover:bg-[#8A5026]"}`;

  return (
    <article className="lift group flex flex-col gap-4 rounded-3xl border border-[#EAE1D5] bg-white p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-bold text-[#362217]">{project.name}</h3>
            <StatusBadge state={state} size="xs" />
          </div>
          <p className="mt-1 flex items-center gap-1.5 truncate font-mono text-[11px] text-[#8C7667]">
            <GitBranch className="h-3.5 w-3.5 shrink-0" /> {project.repoName}{project.branch ? ` · ${project.branch}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onDelete?.(project)}
          className="rounded-lg p-1.5 text-[#B5A596] opacity-60 transition hover:bg-[#9E2A2B]/10 hover:text-[#9E2A2B] group-hover:opacity-100"
          title="Delete project"
          aria-label={`Delete ${project.name}`}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {project.framework && <Chip>{project.framework}</Chip>}
        {project.language && <Chip>{project.language}</Chip>}
        {project.port && <Chip>Port {project.port}</Chip>}
        {project.securityTier === "PROTECTED" && <Chip>Protected</Chip>}
        {project.autoDeploy && <span className="inline-flex items-center gap-1 rounded-full bg-[#2563EB]/10 px-2.5 py-0.5 text-[11px] font-medium text-[#1D4ED8]"><Zap className="h-3 w-3" /> Auto-deploy</span>}
        {domain && <span className="inline-flex items-center gap-1 rounded-full bg-[#2E6B4F]/10 px-2.5 py-0.5 text-[11px] font-medium text-[#2E6B4F]"><Globe className="h-3 w-3" /> Custom domain</span>}
      </div>

      {liveUrl && (
        <a href={liveUrl} target="_blank" rel="noreferrer" className="truncate rounded-xl border border-[#2E6B4F]/20 bg-[#2E6B4F]/5 px-3 py-2 font-mono text-[11px] text-[#2E6B4F] hover:underline">
          {liveUrl.replace(/^https?:\/\//, "")}
        </a>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {primary.href ? (
          <a href={primary.href} target="_blank" rel="noreferrer" className={primaryClass}><PrimaryIcon className="h-3.5 w-3.5" /> {primary.label}</a>
        ) : (
          <button type="button" onClick={() => navigate(primary.to)} className={primaryClass}><PrimaryIcon className={`h-3.5 w-3.5 ${primary.spin ? "animate-spin" : ""}`} /> {primary.label}</button>
        )}
        {state === "live" && (
          <>
            <button type="button" onClick={() => navigate(`${base}/deploy`)} className="inline-flex items-center gap-1.5 rounded-xl border border-[#DCD0C3] px-3 py-2 text-xs font-semibold text-[#5E4C3E] transition hover:bg-[#FAF6F0]">
              <Terminal className="h-3.5 w-3.5" /> Console
            </button>
            <button type="button" onClick={() => navigate(`${base}/monitor`)} className="inline-flex items-center gap-1.5 rounded-xl border border-[#DCD0C3] px-3 py-2 text-xs font-semibold text-[#5E4C3E] transition hover:bg-[#FAF6F0]">
              <Activity className="h-3.5 w-3.5" /> Monitoring
            </button>
          </>
        )}
      </div>

      {previews.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-2xl border border-[#7C4DBA]/20 bg-[#7C4DBA]/5 p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-bold text-[#6D28D9]"><GitPullRequest className="h-3.5 w-3.5" /> {previews.length} pull-request preview{previews.length === 1 ? "" : "s"}</p>
          {previews.map((preview) => {
            const url = ["LIVE", "ROLLED_BACK"].includes(preview.latestDeployment?.status) ? preview.latestDeployment.liveUrl : null;
            return (
              <div key={preview.id} className="flex items-center justify-between gap-2 text-[11px]">
                <Link to={`/project/${preview.id}/deploy`} className="truncate font-semibold text-[#362217] hover:text-[#9E5D2D]">#{preview.previewPr} {preview.gitWatch?.title || preview.branch}</Link>
                {url ? <a href={url} target="_blank" rel="noreferrer" className="shrink-0 font-semibold text-[#6D28D9] hover:underline">Open</a> : <StatusBadge state={projectState(preview)} size="xs" />}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#F0E7DC] pt-3 text-[11px] font-semibold text-[#8C7667]">
        <Link to={`${base}/plan`} className="inline-flex items-center gap-1 hover:text-[#9E5D2D]"><SlidersHorizontal className="h-3.5 w-3.5" /> Environment</Link>
        <Link to={`${base}/infrastructure`} className="inline-flex items-center gap-1 hover:text-[#9E5D2D]"><Server className="h-3.5 w-3.5" /> Infrastructure</Link>
        <Link to={`${base}/security`} className="inline-flex items-center gap-1 hover:text-[#9E5D2D]"><Shield className="h-3.5 w-3.5" /> Security</Link>
        <Link to={`${base}/docker`} className="inline-flex items-center gap-1 hover:text-[#9E5D2D]"><FileCode className="h-3.5 w-3.5" /> Dockerfile</Link>
        <Link to={`${base}/settings`} className="inline-flex items-center gap-1 hover:text-[#9E5D2D]"><Settings2 className="h-3.5 w-3.5" /> Site settings</Link>
        <button type="button" onClick={() => setDetails((open) => !open)} aria-expanded={details} className="ml-auto inline-flex items-center gap-1 hover:text-[#9E5D2D]">
          Build details <ChevronDown className={`h-3.5 w-3.5 transition-transform ${details ? "rotate-180" : ""}`} />
        </button>
      </div>

      {details && (
        <dl className="page-enter grid grid-cols-2 gap-x-4 gap-y-2 rounded-2xl bg-[#FAF8F5] p-3 text-[11px]">
          {[
            ["Package manager", project.packageManager],
            ["Deployment target", project.deploymentTarget ? project.deploymentTarget.replace(/^AWS_/, "").replace(/_/g, " ") : "Not chosen yet"],
            ["Build command", project.buildCommand || "None"],
            ["Start command", project.startCommand || "From the image"],
            ["Docker", project.dockerized ? "Uses the repository's Dockerfile" : "Generated by SkyForge"],
            ["Builds", project.buildMode === "cloud" ? "AWS CodeBuild (falls back to this computer)" : "This computer"],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="font-semibold text-[#8C7667]">{label}</dt>
              <dd className="truncate font-mono text-[#362217]" title={String(value || "")}>{value || "—"}</dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}
