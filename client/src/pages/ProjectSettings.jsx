import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Cpu, ExternalLink, GitBranch, GitPullRequest, Globe, Loader2, RefreshCw, Settings2, ShieldCheck, Trash2, Activity, Zap,
} from "lucide-react";
import {
  addProjectDomain, checkProjectDomain, checkProjectGitNow, getProjectAutomation, getProjectById, getProjectDomain, getProjectStatusPage,
  removeProjectDomain, saveProjectAutomation, saveProjectRuntime, saveProjectStatusPage,
} from "../services/api";
import StatusBadge from "../components/StatusBadge";
import { CopyButton, Notice, PageHeader, Panel, Toggle } from "../components/ui";
import { buttonClass, timeAgo } from "../utils/format";
import { projectState } from "../utils/projectState";

const CPU_MEMORY = { "0.25 vCPU": ["512 MB", "1 GB", "2 GB"], "0.5 vCPU": ["1 GB", "2 GB", "4 GB"], "1 vCPU": ["2 GB", "4 GB"], "2 vCPU": ["4 GB"] };
const message = (error, fallback) => error.response?.data?.message || fallback;

function DnsRecord({ title, record, note }) {
  if (!record) return null;
  return (
    <div className="rounded-2xl border border-[#EAE1D5] bg-[#FAF8F5] p-3">
      <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-[#8C7667]">{title}</p>
      <div className="grid gap-2 text-xs sm:grid-cols-[80px_1fr]">
        <span className="font-semibold text-[#8C7667]">Type</span><span className="font-mono text-[#362217]">{record.type}</span>
        <span className="font-semibold text-[#8C7667]">Name</span>
        <span className="flex min-w-0 items-center gap-2"><span className="truncate font-mono text-[#362217]">{record.name}</span><CopyButton value={record.name} /></span>
        <span className="font-semibold text-[#8C7667]">Value</span>
        <span className="flex min-w-0 items-center gap-2"><span className="truncate font-mono text-[#362217]">{record.value}</span><CopyButton value={record.value} /></span>
      </div>
      {note && <p className="mt-2 text-[11px] text-[#8C7667]">{note}</p>}
    </div>
  );
}

const DOMAIN_STATE = {
  PENDING_VALIDATION: { label: "Waiting for DNS", state: "working" },
  ACTIVE: { label: "Active (HTTPS)", state: "live" },
  ATTACH_FAILED: { label: "Couldn't attach", state: "failed" },
  FAILED: { label: "Certificate failed", state: "failed" },
};

/** Per-site settings that apply after deploy: automation, domain, size, status page. */
export default function ProjectSettings() {
  const { id } = useParams();
  const [project, setProject] = useState(null);
  const [automation, setAutomation] = useState(null);
  const [domain, setDomain] = useState(null);
  const [domainInput, setDomainInput] = useState("");
  const [statusPage, setStatusPage] = useState(null);
  const [runtime, setRuntime] = useState({ port: "", cpu: "0.5 vCPU", memory: "1 GB", healthCheck: "/" });
  const [busy, setBusy] = useState(null);
  const [feedback, setFeedback] = useState(null);

  const say = (kind, text) => setFeedback({ kind, text });
  const run = async (key, action) => {
    setBusy(key);
    setFeedback(null);
    try {
      await action();
    } catch (error) {
      say("error", message(error, "That didn't work. Try again."));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    getProjectById(id).then((data) => {
      setProject(data);
      setRuntime({ port: data.port || "", cpu: data.cpu || "0.5 vCPU", memory: data.memory || "1 GB", healthCheck: data.healthCheck || "/" });
    }).catch((error) => say("error", message(error, "Could not load the project.")));
    getProjectAutomation(id).then(setAutomation).catch(() => {});
    getProjectDomain(id).then((data) => setDomain(data.domain)).catch(() => {});
    getProjectStatusPage(id).then((data) => setStatusPage(data.statusPage)).catch(() => {});
  }, [id]);

  // While a certificate is pending, check it every 30 seconds.
  useEffect(() => {
    if (domain?.status !== "PENDING_VALIDATION") return undefined;
    const timer = window.setInterval(() => {
      checkProjectDomain(id).then((data) => setDomain(data.domain)).catch(() => {});
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [id, domain?.status]);

  const statusUrl = statusPage?.slug ? `${window.location.origin}/status/${statusPage.slug}` : null;
  const isPreview = Boolean(project?.parentProjectId);
  const domainState = DOMAIN_STATE[domain?.status] || null;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <PageHeader
        back
        icon={Settings2}
        title={`Site settings${project ? ` · ${project.name}` : ""}`}
        subtitle="Automatic deploys, previews, your own domain, server size, and a public status page."
        actions={project && (
          <>
            <Link to={`/project/${id}/monitor`} className={buttonClass.secondary}><Activity className="h-3.5 w-3.5" /> Monitoring</Link>
            <Link to={`/project/${id}/deploy`} className={buttonClass.secondary}>Console</Link>
          </>
        )}
      />

      {feedback && <Notice kind={feedback.kind}>{feedback.text}</Notice>}
      {isPreview && <Notice kind="info">This is a pull-request preview. It follows its pull request and is removed when the PR closes. Change settings on the main project.</Notice>}

      {!isPreview && (
        <Panel
          icon={Zap}
          title="Deploy automatically when you push"
          description={`Every push to ${automation?.branch || project?.branch || "the branch"} deploys the new code. If a deploy fails, the previous version keeps running.`}
          actions={automation && (
            <Toggle
              label="Auto-deploy"
              checked={automation.autoDeploy}
              disabled={busy === "auto"}
              onChange={(value) => run("auto", async () => {
                setAutomation(await saveProjectAutomation(id, { autoDeploy: value }));
                say("success", value ? "Auto-deploy is on. SkyForge checks GitHub every minute; the next push deploys automatically." : "Auto-deploy is off.");
              })}
            />
          )}
        >
          {automation?.autoDeploy && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#5E4C3E]">
                <span className="inline-flex items-center gap-1"><GitBranch className="h-3.5 w-3.5" /> Watching <b className="font-mono">{automation.branch}</b></span>
                {automation.watch?.headSha && <span>Latest commit <span className="font-mono">{automation.watch.headSha.slice(0, 7)}</span></span>}
                {automation.watch?.checkedAt && <span>Checked {timeAgo(automation.watch.checkedAt)}</span>}
                <button type="button" disabled={busy === "check"} onClick={() => run("check", async () => {
                  const result = await checkProjectGitNow(id);
                  setAutomation(result);
                  say("success", result.summary?.length ? result.summary.join(" · ") : "Checked GitHub: nothing new.");
                })} className="inline-flex items-center gap-1 font-semibold text-[#9E5D2D] hover:underline">
                  {busy === "check" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Check now
                </button>
              </div>
              {automation.watch?.lastError && <Notice kind="warn">{automation.watch.lastError}</Notice>}
              <p className="text-[11px] text-[#8C7667]">
                {automation.webhook?.enabled
                  ? "Instant deploys: GitHub webhooks are enabled on this server. Add a webhook in the repository settings pointing at this server's /api/github/webhook URL."
                  : "SkyForge checks for pushes once a minute. For instant deploys when SkyForge runs on a public server, set GITHUB_WEBHOOK_SECRET and add a GitHub webhook."}
              </p>
            </div>
          )}
        </Panel>
      )}

      {!isPreview && (
        <Panel
          icon={GitPullRequest}
          title="Preview every pull request"
          description={`Each open pull request into ${automation?.branch || "the branch"} gets its own temporary copy of the site, rebuilt on every push and deleted when the PR is merged or closed. Only branches of this repository, never forks, so outside code never runs with your keys.`}
          actions={automation && (
            <Toggle
              label="Pull-request previews"
              checked={automation.previewsEnabled}
              disabled={busy === "previews"}
              onChange={(value) => run("previews", async () => {
                setAutomation(await saveProjectAutomation(id, { previewsEnabled: value }));
                say("success", value ? "Previews are on. Open pull requests get a preview within a few minutes." : "Previews are off. Existing previews are being removed.");
              })}
            />
          )}
        >
          {automation?.previewsEnabled && (
            <Notice kind="warn" className="mb-3">Each preview runs its own container and load balancer (about $1.20/day while the PR is open, up to {automation.maxPreviews} at once). It's deleted automatically when the PR closes.</Notice>
          )}
          {automation?.previews?.length ? (
            <ul className="flex flex-col gap-2">
              {automation.previews.map((preview) => (
                <li key={preview.id} className="flex flex-col gap-2 rounded-2xl border border-[#EAE1D5] p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-[#362217]">#{preview.previewPr}</span>
                      <span className="truncate text-xs text-[#5E4C3E]">{preview.gitWatch?.title || preview.branch}</span>
                      <StatusBadge state={projectState(preview)} size="xs" />
                    </div>
                    <p className="font-mono text-[11px] text-[#8C7667]">{preview.branch}</p>
                    {preview.gitWatch?.lastError && <p className="text-[11px] text-[#9E2A2B]">{preview.gitWatch.lastError}</p>}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {preview.gitWatch?.url && <a href={preview.gitWatch.url} target="_blank" rel="noreferrer" className={buttonClass.secondary}>Pull request</a>}
                    {preview.latestDeployment?.liveUrl && ["LIVE", "ROLLED_BACK"].includes(preview.latestDeployment.status) && <a href={preview.latestDeployment.liveUrl} target="_blank" rel="noreferrer" className={buttonClass.primary}><ExternalLink className="h-3.5 w-3.5" /> Open preview</a>}
                    <Link to={`/project/${preview.id}/deploy`} className={buttonClass.secondary}>Console</Link>
                  </div>
                </li>
              ))}
            </ul>
          ) : automation?.previewsEnabled ? <p className="text-xs text-[#8C7667]">No open pull requests yet.</p> : null}
        </Panel>
      )}

      <Panel
        icon={Globe}
        title="Custom domain"
        description="Use your own address (like app.example.com) with a free HTTPS certificate from AWS. You add two DNS records at your domain provider; SkyForge does the rest."
        actions={domainState && <StatusBadge state={domainState.state} label={domainState.label} />}
      >
        {!domain ? (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              run("domain", async () => {
                const result = await addProjectDomain(id, domainInput);
                setDomain(result.domain);
                say("success", "Certificate requested. Add the DNS records below; SkyForge checks every 30 seconds.");
              });
            }}
          >
            <input value={domainInput} onChange={(event) => setDomainInput(event.target.value)} placeholder="app.example.com" className="h-10 flex-1 rounded-xl border border-[#DCD0C3] bg-white px-3 font-mono text-sm text-[#362217] outline-none focus:border-[#9E5D2D]" />
            <button type="submit" disabled={!domainInput.trim() || busy === "domain"} className={buttonClass.primary}>{busy === "domain" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} Add domain</button>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <a href={`https://${domain.domain}`} target="_blank" rel="noreferrer" className="font-mono text-sm font-bold text-[#9E5D2D] hover:underline">https://{domain.domain}</a>
              {domain.checkedAt && <span className="text-[11px] text-[#8C7667]">checked {timeAgo(domain.checkedAt)}</span>}
            </div>
            {domain.status === "ACTIVE" ? (
              <Notice kind="success">Your domain is live with HTTPS. Keep both DNS records in place: AWS uses the first one to renew the certificate automatically.</Notice>
            ) : domain.status === "PENDING_VALIDATION" ? (
              <Notice kind="info">Add both records at your domain provider (GoDaddy, Namecheap, Cloudflare, Route 53…). AWS usually issues the certificate within 5–30 minutes of the first record appearing. On Cloudflare, set the records to "DNS only" (grey cloud).</Notice>
            ) : domain.error ? <Notice kind="error">{domain.error}</Notice> : null}
            <DnsRecord title="1. Prove you own the domain" record={domain.validation} note="Lets AWS issue (and later renew) the HTTPS certificate." />
            <DnsRecord title="2. Send visitors to your site" record={domain.routing} note="For a root domain (example.com without www), use your provider's ALIAS/ANAME/flattened CNAME option." />
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy === "domain-check"} onClick={() => run("domain-check", async () => setDomain((await checkProjectDomain(id)).domain))} className={buttonClass.secondary}>
                {busy === "domain-check" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Check now
              </button>
              <button type="button" disabled={busy === "domain-remove"} onClick={() => {
                if (!window.confirm(`Remove ${domain.domain} from this site? Its certificate is deleted too.`)) return;
                run("domain-remove", async () => {
                  const result = await removeProjectDomain(id);
                  setDomain(null);
                  say("success", result.message);
                });
              }} className={buttonClass.danger}>
                {busy === "domain-remove" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Remove domain
              </button>
            </div>
          </div>
        )}
      </Panel>

      <Panel icon={Cpu} title="Server size and port" description="Changes apply the next time you deploy. Bigger sizes cost more per hour.">
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            run("runtime", async () => {
              const result = await saveProjectRuntime(id, { port: Number(runtime.port), cpu: runtime.cpu, memory: runtime.memory, healthCheck: runtime.healthCheck });
              say("success", result.message);
            });
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-semibold text-[#5E4C3E]">
            Port the app listens on
            <input type="number" min="1" max="65535" value={runtime.port} onChange={(event) => setRuntime({ ...runtime, port: event.target.value })} className="h-10 rounded-xl border border-[#DCD0C3] bg-white px-3 font-mono text-sm text-[#362217] outline-none focus:border-[#9E5D2D]" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-[#5E4C3E]">
            Health-check path
            <input value={runtime.healthCheck} onChange={(event) => setRuntime({ ...runtime, healthCheck: event.target.value })} className="h-10 rounded-xl border border-[#DCD0C3] bg-white px-3 font-mono text-sm text-[#362217] outline-none focus:border-[#9E5D2D]" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-[#5E4C3E]">
            CPU
            <select value={runtime.cpu} onChange={(event) => {
              const cpu = event.target.value;
              setRuntime({ ...runtime, cpu, memory: CPU_MEMORY[cpu].includes(runtime.memory) ? runtime.memory : CPU_MEMORY[cpu][0] });
            }} className="h-10 rounded-xl border border-[#DCD0C3] bg-white px-3 text-sm text-[#362217] outline-none">
              {Object.keys(CPU_MEMORY).map((cpu) => <option key={cpu}>{cpu}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-[#5E4C3E]">
            Memory
            <select value={runtime.memory} onChange={(event) => setRuntime({ ...runtime, memory: event.target.value })} className="h-10 rounded-xl border border-[#DCD0C3] bg-white px-3 text-sm text-[#362217] outline-none">
              {CPU_MEMORY[runtime.cpu].map((memory) => <option key={memory}>{memory}</option>)}
            </select>
          </label>
          <div className="sm:col-span-2">
            <button type="submit" disabled={busy === "runtime"} className={buttonClass.primary}>{busy === "runtime" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save</button>
          </div>
        </form>
      </Panel>

      <Panel
        icon={Activity}
        title="Public status page"
        description="A page anyone can open to see whether the site is up, with 90 days of uptime. It never shows your code, account or AWS details."
        actions={statusPage && (
          <Toggle
            label="Public status page"
            checked={Boolean(statusPage.enabled)}
            disabled={busy === "status"}
            onChange={(value) => run("status", async () => setStatusPage((await saveProjectStatusPage(id, { enabled: value })).statusPage))}
          />
        )}
      >
        {statusPage?.enabled && statusUrl && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-[#FAF8F5] p-3">
              <a href={statusUrl} target="_blank" rel="noreferrer" className="min-w-0 truncate font-mono text-xs font-semibold text-[#9E5D2D] hover:underline">{statusUrl}</a>
              <CopyButton value={statusUrl} />
            </div>
            <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => {
              event.preventDefault();
              const title = new FormData(event.currentTarget).get("title");
              run("status-title", async () => {
                setStatusPage((await saveProjectStatusPage(id, { title })).statusPage);
                say("success", "Status page title saved.");
              });
            }}>
              <input name="title" defaultValue={statusPage.title || ""} placeholder={`Title (default: ${project?.name || "project name"})`} className="h-10 flex-1 rounded-xl border border-[#DCD0C3] bg-white px-3 text-sm text-[#362217] outline-none focus:border-[#9E5D2D]" />
              <button type="submit" className={buttonClass.secondary}>Save title</button>
              <button type="button" onClick={() => {
                if (!window.confirm("Make a new link? The old one stops working.")) return;
                run("status-link", async () => setStatusPage((await saveProjectStatusPage(id, { newLink: true })).statusPage));
              }} className={buttonClass.secondary}>New link</button>
            </form>
          </div>
        )}
      </Panel>
    </div>
  );
}
