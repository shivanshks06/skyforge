import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Bug,
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  KeyRound,
  Power,
  PowerOff,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import Card from "../components/Card";
import Button from "../components/Button";
import { IncidentsPanel, ProtectionSettingsPanel, DeceptionPanel, SecurityToolsPanel, SurfacePanel } from "../components/SecurityPanels";
import {
  getBlastRadius,
  getCostEstimate,
  replayBlockedAttacks,
  resolveSecurityIncident,
  rotateAdminDoor,
  runRedTeamRehearsal,
  runSecurityChecksNow,
  saveSecuritySettings,
  bringSiteOnline,
  createSecurityFixPullRequest,
  getProjectSecurity,
  runProjectSecurityScan,
  setProjectSecurityTier,
  setUnderAttackMode,
  takeSiteOffline,
  unbanProjectIp,
} from "../services/api";

const SEVERITY_STYLE = {
  critical: "bg-[#9E2A2B]/10 text-[#9E2A2B] border-[#9E2A2B]/30",
  high: "bg-orange-500/10 text-orange-700 border-orange-500/30",
  medium: "bg-amber-500/10 text-amber-700 border-amber-500/30",
  low: "bg-[#3B7A75]/10 text-[#3B7A75] border-[#3B7A75]/30",
  info: "bg-[#FAF8F5] text-[#8C7667] border-[#EAE1D5]",
};
const GRADE_STYLE = { A: "text-[#2E6B4F]", B: "text-[#3B7A75]", C: "text-amber-600", D: "text-orange-600", F: "text-[#9E2A2B]" };

const FREE_FEATURES = [
  "Security score: code scan + safe self-pentest after every deploy",
  "Security gate before traffic switches (secrets, critical CVEs)",
  "Alerts on Email, Slack, Discord, Telegram, webhooks + auto incident response",
  "Canary secret, leak watch, new-CVE (OSV) and pushed-secret alerts",
  "AI red-team rehearsal, blast-radius map, attack-surface diff per deploy",
  "Outbound firewall, read-only containers, AWS permissions from code",
  "Denial-of-wallet guard; decoy files on static sites",
  "One-click AI fix pull requests; AWS Shield Standard always on",
];
const PROTECTED_FEATURES = [
  "Everything in Free",
  "AWS WAF: OWASP core, SQL injection, known bad inputs, IP reputation",
  "Decoy .env / AWS keys with honey credentials, robots.txt bait",
  "Tripwire auto-bans + herd immunity across all your projects",
  "Self-tuning rate limits and login brute-force limits from your code",
  "Admin lockdown, rotating admin door, bot challenge",
  "Under Attack mode (automatic on spikes), dashboard, attack replay",
];

function TopList({ title, items }) {
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <span className="text-[11px] font-bold text-[#8C7667] uppercase tracking-wide">{title}</span>
      {items?.length ? items.map((item) => (
        <div key={item.value} className="flex items-center justify-between gap-2 text-xs">
          <span className="font-mono text-[#362217] truncate">{item.value}</span>
          <span className="font-bold text-[#9E2A2B] shrink-0">{item.count}</span>
        </div>
      )) : <span className="text-xs text-[#A39284]">None</span>}
    </div>
  );
}

export default function Security() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const notify = (message, type = "success") => {
    window.clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  };

  const load = async () => {
    try {
      setData(await getProjectSecurity(id));
      setLoadError(null);
    } catch (err) {
      setLoadError(err.response?.data?.message || "Could not load security status.");
    }
  };

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const poll = window.setInterval(() => void load(), 20_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(poll);
      window.clearTimeout(toastTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const run = async (key, action, success) => {
    setBusy(key);
    try {
      const result = await action();
      notify(success || result?.message || "Done.");
      await load();
      return result;
    } catch (err) {
      notify(err.response?.data?.message || "The request failed.", "error");
      return null;
    } finally {
      setBusy(null);
    }
  };

  const [toolResults, setToolResults] = useState({});
  const tool = async (key, action, field) => {
    const result = await run(key, action);
    if (result) setToolResults((current) => ({ ...current, [field]: { ...result, at: result.at || new Date().toISOString() } }));
  };

  const switchTier = (tier) => {
    if (tier === data?.tier) return;
    if (tier === "PROTECTED" && !window.confirm(`Protected tier adds AWS WAF to this site: ${data.tiers.PROTECTED.monthlyCost}. Continue?`)) return;
    void run("tier", () => setProjectSecurityTier(id, tier));
  };

  if (loadError && !data) {
    return (
      <div className="p-8 flex flex-col items-center gap-4 text-center">
        <AlertTriangle className="h-8 w-8 text-[#9E2A2B]" />
        <p className="text-sm text-[#5E4C3E]">{loadError}</p>
        <Button onClick={load} icon={RefreshCw}>Retry</Button>
      </div>
    );
  }
  if (!data) return <div className="p-8 text-sm text-[#8C7667]">Loading security status...</div>;

  const report = data.report;
  const protectedTier = data.tier === "PROTECTED";
  const firewall = data.protection?.firewall;
  const canary = data.protection?.canary;
  const counts = (report?.findings || []).reduce((total, item) => ({ ...total, [item.severity]: (total[item.severity] || 0) + 1 }), {});

  return (
    <div className="flex flex-col gap-6 pb-10">
      {toast && (
        <div className={`fixed top-5 right-5 z-50 max-w-md rounded-xl border px-4 py-3 text-sm shadow-lg ${toast.type === "error" ? "bg-[#FDF2F2] border-[#9E2A2B]/30 text-[#9E2A2B]" : "bg-[#F1F8F4] border-[#2E6B4F]/30 text-[#2E6B4F]"}`}>
          {toast.message}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate(`/project/${id}/deploy`)} className="p-2 rounded-xl border border-[#EADFCF] bg-white text-[#5E4C3E] hover:bg-[#FAF6F0]" aria-label="Back to deployment console">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-[#362217] flex items-center gap-2"><Shield className="h-6 w-6 text-[#9E5D2D]" /> Security</h1>
            <p className="text-sm text-[#5E4C3E]">Scan results, protection tier, firewall, and site availability.</p>
          </div>
        </div>
        <Button icon={RefreshCw} loading={busy === "scan"} disabled={Boolean(busy)} onClick={() => run("scan", () => runProjectSecurityScan(id), "Security scan finished.")}>
          Run security scan
        </Button>
      </div>

      {/* Site availability */}
      <Card glow={false} className="bg-white border border-[#EAE1D5] flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className={`h-3 w-3 rounded-full ${!data.site.live ? "bg-[#A39284]" : data.site.offline ? "bg-amber-500" : data.protection?.resuming ? "bg-[#3B7A75] animate-pulse" : "bg-[#2E6B4F]"}`} />
            <div>
              <div className="text-sm font-bold text-[#362217]">
                {!data.site.live ? "Not deployed" : data.site.offline ? "Offline (maintenance page)" : data.protection?.resuming ? "Starting up..." : "Online"}
              </div>
              {data.site.url && <a href={data.site.url} target="_blank" rel="noreferrer" className="text-xs font-mono text-[#9E5D2D] hover:underline break-all">{data.site.url}</a>}
            </div>
          </div>
          {data.site.live && (data.site.offline ? (
            <Button icon={Power} loading={busy === "online"} disabled={Boolean(busy)} onClick={() => run("online", () => bringSiteOnline(id))}>Bring site online</Button>
          ) : (
            <Button
              variant="outline"
              icon={PowerOff}
              loading={busy === "offline"}
              disabled={Boolean(busy) || data.protection?.resuming}
              onClick={() => window.confirm("Take the site offline? Visitors will see a maintenance page and the container stops. Nothing is deleted.") && run("offline", () => takeSiteOffline(id))}
              className="border-amber-500/40 text-amber-700 hover:bg-amber-500/10"
            >
              Take site offline
            </Button>
          ))}
        </div>
        <p className="text-[11px] text-[#8C7667]">
          Offline stops the container (no compute charges) and shows a maintenance page; the load balancer keeps billing (~$0.55/day). Use <strong>One-Click Destroy</strong> on the deployment page to delete everything and stop all charges.
        </p>
      </Card>

      <IncidentsPanel
        incidents={data.incidents}
        alertChannels={data.alertChannels}
        busy={busy}
        onResolve={(incidentId) => run("resolve", () => resolveSecurityIncident(id, incidentId))}
        onRunChecks={() => run("checks", () => runSecurityChecksNow(id))}
      />

      {/* Tier */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {[["FREE", ShieldCheck, FREE_FEATURES], ["PROTECTED", ShieldAlert, PROTECTED_FEATURES]].map(([tier, Icon, features]) => (
          <button
            key={tier}
            type="button"
            onClick={() => switchTier(tier)}
            disabled={Boolean(busy)}
            className={`text-left p-5 rounded-2xl border-2 transition flex flex-col gap-3 ${data.tier === tier ? "bg-white border-[#9E5D2D] ring-2 ring-[#9E5D2D]/20" : "bg-white/70 border-[#EADFCF] hover:border-[#8C7667]"}`}
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-base font-bold text-[#362217]"><Icon className="h-5 w-5 text-[#9E5D2D]" /> {data.tiers[tier].label}</span>
              <span className="text-xs font-bold font-mono text-[#5E4C3E]">{tier === "FREE" ? "$0" : "~$14-20/month"}</span>
            </div>
            <ul className="flex flex-col gap-1">
              {features.map((feature) => (
                <li key={feature} className="flex items-start gap-1.5 text-xs text-[#5E4C3E]"><CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-[#2E6B4F]" />{feature}</li>
              ))}
            </ul>
            {data.tier === tier && <span className="text-[11px] font-bold text-[#9E5D2D]">{busy === "tier" ? "Applying..." : "Current tier"}</span>}
          </button>
        ))}
      </div>

      <ProtectionSettingsPanel data={data} busy={busy} onSave={(settings) => run("settings", () => saveSecuritySettings(id, settings))} />

      <DeceptionPanel data={data} busy={busy} onRotateDoor={() => run("door", () => rotateAdminDoor(id))} />

      <SecurityToolsPanel
        data={data}
        busy={busy}
        results={toolResults}
        onRedTeam={() => tool("redteam", () => runRedTeamRehearsal(id), "redTeam")}
        onReplay={() => tool("replay", () => replayBlockedAttacks(id), "replay")}
        onBlastRadius={() => tool("blast", () => getBlastRadius(id), "blast")}
        onCost={() => tool("cost", () => getCostEstimate(id), "cost")}
      />

      <SurfacePanel data={data} />

      {/* Score + findings */}
      <Card glow={false} className="bg-white border border-[#EAE1D5] flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#EADFCF] pb-3">
          <div className="flex items-center gap-4">
            <div className={`text-5xl font-black ${GRADE_STYLE[report?.grade] || "text-[#A39284]"}`}>{report?.grade || "–"}</div>
            <div>
              <div className="text-sm font-bold text-[#362217]">Security score {report ? `${report.score}/100` : "not available yet"}</div>
              <div className="text-xs text-[#8C7667]">
                {report ? `Scanned ${new Date(report.generatedAt).toLocaleString()}` : "Runs automatically after each deployment, or use “Run security scan”."}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {["critical", "high", "medium", "low"].map((severity) => (
              <span key={severity} className={`px-2.5 py-0.5 rounded-full border text-[11px] font-bold ${SEVERITY_STYLE[severity]}`}>{counts[severity] || 0} {severity}</span>
            ))}
          </div>
        </div>

        {report?.findings?.length ? (
          <ul className="flex flex-col divide-y divide-[#F0E7DC]">
            {report.findings.map((item) => (
              <li key={item.id} className="py-3 flex flex-col gap-1.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex items-start gap-2 min-w-0">
                    <span className={`shrink-0 px-2 py-0.5 rounded border text-[10px] font-bold uppercase ${SEVERITY_STYLE[item.severity]}`}>{item.severity}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-[#362217]">{item.title}</div>
                      <div className="text-[11px] font-mono text-[#8C7667] break-all">{item.source} · {item.location}</div>
                    </div>
                  </div>
                  {item.fixUrl ? (
                    <a href={item.fixUrl} target="_blank" rel="noreferrer" className="shrink-0 inline-flex items-center gap-1 text-xs font-bold text-[#2E6B4F] hover:underline">
                      <ExternalLink className="h-3.5 w-3.5" /> {item.fixKind === "pull_request" ? "View pull request" : "Open fix (your fork)"}
                    </a>
                  ) : item.fixable ? (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={GitPullRequest}
                      loading={busy === item.id}
                      disabled={Boolean(busy)}
                      onClick={() => run(item.id, () => createSecurityFixPullRequest(id, item.id), "Fix committed to a new branch on GitHub.")}
                    >
                      Create fix PR
                    </Button>
                  ) : null}
                </div>
                {item.detail && <p className="text-xs text-[#5E4C3E]">{item.detail}</p>}
                {item.fix && <p className="text-xs text-[#2E6B4F]"><strong>Fix:</strong> {item.fix}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <div className="p-5 rounded-2xl bg-[#FAF8F5] text-center text-xs text-[#8C7667]">{report ? "No issues found." : "No scan yet."}</div>
        )}
      </Card>

      {/* Image + canary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card glow={false} className="bg-white border border-[#EAE1D5] flex flex-col gap-2">
          <span className="flex items-center gap-2 text-sm font-bold text-[#362217]"><Bug className="h-4 w-4 text-[#9E5D2D]" /> Container image vulnerabilities</span>
          {report?.image?.status === "COMPLETE" ? (
            <div className="flex flex-wrap gap-1.5">
              {["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((severity) => (
                <span key={severity} className={`px-2.5 py-0.5 rounded-full border text-[11px] font-bold ${SEVERITY_STYLE[severity.toLowerCase()]}`}>{report.image.counts?.[severity] || 0} {severity.toLowerCase()}</span>
              ))}
            </div>
          ) : (
            <span className="text-xs text-[#8C7667]">{report?.image?.status === "IN_PROGRESS" ? "Scan in progress — run the security scan again in a few minutes." : "Scanned automatically on each deployment (ECR, free)."}</span>
          )}
        </Card>
        <Card glow={false} className="bg-white border border-[#EAE1D5] flex flex-col gap-2">
          <span className="flex items-center gap-2 text-sm font-bold text-[#362217]"><KeyRound className="h-4 w-4 text-[#9E5D2D]" /> Canary secret</span>
          {canary ? (
            canary.status?.used ? (
              <span className="text-xs font-bold text-[#9E2A2B]">TRIGGERED: the planted key was used {canary.status.lastUsedAt}. Your container's secrets have leaked — rotate them.</span>
            ) : (
              <span className="text-xs text-[#5E4C3E]">Armed ({canary.accessKeyId.slice(0, 8)}…). Never used — no sign of leaked secrets.{canary.status?.checkedAt ? ` Last checked ${new Date(canary.status.checkedAt).toLocaleString()}.` : ""}</span>
            )
          ) : (
            <span className="text-xs text-[#8C7667]">Planted on the next deployment (needs IAM user permissions).</span>
          )}
        </Card>
      </div>

      {/* Firewall (Protected) */}
      {protectedTier && (
        <Card glow={false} className="bg-white border border-[#EAE1D5] flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#EADFCF] pb-3">
            <span className="flex items-center gap-2 text-base font-bold text-[#362217]"><ShieldAlert className="h-5 w-5 text-[#9E5D2D]" /> Firewall {firewall?.active ? "active" : "(applies on next deploy)"}</span>
            {firewall?.active && (
              <Button
                size="sm"
                variant={firewall.underAttack ? "primary" : "outline"}
                icon={AlertTriangle}
                loading={busy === "attack"}
                disabled={Boolean(busy)}
                onClick={() => run("attack", () => setUnderAttackMode(id, !firewall.underAttack))}
                className={firewall.underAttack ? "bg-[#9E2A2B] hover:bg-[#7E2223] text-white" : "border-[#9E2A2B]/40 text-[#9E2A2B]"}
              >
                {firewall.underAttack ? "Under Attack mode: ON" : "Enable Under Attack mode"}
              </Button>
            )}
          </div>

          {data.firewall && (
            <div className="flex flex-col gap-3">
              <div className="text-sm text-[#362217]"><strong className="text-[#9E2A2B]">{data.firewall.sampledBlocked}</strong> blocked requests sampled in the last {data.firewall.windowHours} hours</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <TopList title="By rule" items={data.firewall.byRule} />
                <TopList title="Top attacker IPs" items={data.firewall.topIps} />
                <TopList title="Countries" items={data.firewall.topCountries} />
                <TopList title="Targeted paths" items={data.firewall.topPaths} />
              </div>
            </div>
          )}

          {firewall?.active && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs text-[#5E4C3E]">
              <div><strong>Honeypot tripwires:</strong> <span className="font-mono">{firewall.tripwirePaths.join("  ")}</span></div>
              <div><strong>Login routes from your code (strict limit):</strong> <span className="font-mono">{firewall.loginPaths.length ? firewall.loginPaths.join("  ") : "keyword match (login, auth, admin, ...)"}</span></div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-2 text-sm font-bold text-[#362217]"><Ban className="h-4 w-4 text-[#9E2A2B]" /> Auto-banned IPs ({data.protection.bans.length})</span>
            {data.protection.bans.length ? (
              <ul className="flex flex-col divide-y divide-[#F0E7DC] rounded-xl border border-[#EAE1D5]">
                {data.protection.bans.map((ban) => (
                  <li key={ban.ip} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                    <span className="font-mono font-bold text-[#362217]">{ban.ip}</span>
                    <span className="text-[#8C7667]">{ban.reason} · until {new Date(ban.until).toLocaleString()}</span>
                    <Button size="sm" variant="outline" loading={busy === ban.ip} disabled={Boolean(busy)} onClick={() => run(ban.ip, () => unbanProjectIp(id, ban.ip))}>Unban</Button>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-xs text-[#8C7667]">No active bans. IPs that touch a honeypot path are banned for 24 hours (checked every ~10 minutes).</span>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
