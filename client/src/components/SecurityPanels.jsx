import { useState } from "react";
import {
  Activity, AlertTriangle, Bell, CheckCircle2, Copy, DoorOpen, Eye, FileWarning, Fingerprint, GitCommit, Layers, Lock, Network,
  PiggyBank, Radar, RefreshCw, Repeat, Save, ShieldAlert, Swords, Target,
} from "lucide-react";
import Card from "./Card";
import Button from "./Button";

const SEVERITY_STYLE = {
  critical: "bg-[#9E2A2B]/10 text-[#9E2A2B] border-[#9E2A2B]/30",
  high: "bg-orange-500/10 text-orange-700 border-orange-500/30",
  medium: "bg-amber-500/10 text-amber-700 border-amber-500/30",
  low: "bg-[#3B7A75]/10 text-[#3B7A75] border-[#3B7A75]/30",
  info: "bg-[#FAF8F5] text-[#8C7667] border-[#EAE1D5]",
};

const when = (value) => (value ? new Date(value).toLocaleString() : "never");

function Section({ icon: Icon, title, subtitle, right, children }) {
  return (
    <Card glow={false} className="bg-white border border-[#EAE1D5] flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#EADFCF] pb-3">
        <div className="flex items-start gap-2">
          <Icon className="h-5 w-5 text-[#9E5D2D] mt-0.5" />
          <div>
            <h3 className="text-base font-bold text-[#362217]">{title}</h3>
            {subtitle && <p className="text-xs text-[#5E4C3E]">{subtitle}</p>}
          </div>
        </div>
        {right}
      </div>
      {children}
    </Card>
  );
}

// ---------------------------------------------------------------- incidents

export function IncidentsPanel({ incidents = [], alertChannels = [], onResolve, onRunChecks, busy }) {
  const [expanded, setExpanded] = useState(null);
  return (
    <Section
      icon={Bell}
      title="Incidents & automatic response"
      subtitle={alertChannels.length ? `Alerts go to: ${alertChannels.join(", ")}.` : "No alert channel configured yet — add Email, Slack, Discord or Telegram in Settings."}
      right={<Button size="sm" variant="outline" icon={RefreshCw} loading={busy === "checks"} disabled={Boolean(busy)} onClick={onRunChecks}>Run all checks now</Button>}
    >
      {incidents.length ? (
        <ul className="flex flex-col divide-y divide-[#F0E7DC]">
          {incidents.map((incident) => (
            <li key={incident.id} className={`py-3 flex flex-col gap-1.5 ${incident.resolvedAt ? "opacity-60" : ""}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <button type="button" className="flex items-start gap-2 text-left min-w-0" onClick={() => setExpanded(expanded === incident.id ? null : incident.id)}>
                  <span className={`shrink-0 px-2 py-0.5 rounded border text-[10px] font-bold uppercase ${SEVERITY_STYLE[incident.severity]}`}>{incident.severity}</span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-[#362217]">{incident.title}</span>
                    <span className="block text-[11px] text-[#8C7667]">{when(incident.createdAt)} · {incident.kind}{incident.alerts?.length ? ` · alerted ${incident.alerts.filter((alert) => alert.ok).map((alert) => alert.channel).join(", ") || "(failed)"}` : ""}</span>
                  </span>
                </button>
                {!incident.resolvedAt && <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => onResolve(incident.id)}>Resolve</Button>}
              </div>
              {incident.summary && <p className="text-xs text-[#5E4C3E]">{incident.summary}</p>}
              {incident.actions?.length > 0 && (
                <ul className="text-xs text-[#2E6B4F] flex flex-col gap-0.5">
                  {incident.actions.map((action) => <li key={action} className="flex items-start gap-1"><CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />{action}</li>)}
                </ul>
              )}
              {expanded === incident.id && incident.detail && (
                <pre className="text-[10px] font-mono bg-[#FAF8F5] border border-[#EAE1D5] rounded-lg p-2 overflow-x-auto max-h-64 text-[#362217]">{JSON.stringify(incident.detail, null, 2)}</pre>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="p-5 rounded-2xl bg-[#FAF8F5] text-center text-xs text-[#8C7667]">No incidents. SkyForge checks bans, decoys, canary and honey keys, attack spikes, pushed secrets and costs every 10–60 minutes, leaks every 6 hours and CVEs daily.</div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- settings

function Toggle({ label, help, checked, onChange, disabled, badge }) {
  return (
    <label className={`flex items-start gap-3 rounded-xl border p-3 ${checked ? "border-[#9E5D2D]/40 bg-[#FFFBF6]" : "border-[#EADFCF] bg-white"} ${disabled ? "opacity-60" : "cursor-pointer"}`}>
      <input type="checkbox" className="mt-0.5 accent-[#9E5D2D]" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold text-[#362217] flex items-center gap-2">{label}{badge && <span className="px-1.5 py-0.5 rounded bg-[#9E5D2D]/10 text-[#9E5D2D] text-[10px] font-bold uppercase">{badge}</span>}</span>
        <span className="text-[11px] text-[#5E4C3E]">{help}</span>
      </span>
    </label>
  );
}

function Choice({ label, help, value, options, onChange, badge }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-[#EADFCF] bg-white p-3">
      <span className="text-sm font-semibold text-[#362217] flex items-center gap-2">{label}{badge && <span className="px-1.5 py-0.5 rounded bg-[#9E5D2D]/10 text-[#9E5D2D] text-[10px] font-bold uppercase">{badge}</span>}</span>
      <span className="text-[11px] text-[#5E4C3E]">{help}</span>
      <div className="flex flex-wrap gap-1.5 mt-1">
        {options.map(([optionValue, optionLabel]) => (
          <button key={optionValue} type="button" onClick={() => onChange(optionValue)} className={`px-2.5 py-1 rounded-lg border text-xs font-semibold ${value === optionValue ? "bg-[#9E5D2D] border-[#9E5D2D] text-white" : "bg-white border-[#EADFCF] text-[#5E4C3E] hover:border-[#8C7667]"}`}>{optionLabel}</button>
        ))}
      </div>
    </div>
  );
}

export function ProtectionSettingsPanel({ data, onSave, busy }) {
  const protection = data.protection || {};
  const [draft, setDraft] = useState(() => ({ ...protection.settings, adminAllowIps: (protection.settings?.adminAllowIps || []).join(", ") }));
  const set = (key) => (value) => setDraft((current) => ({ ...current, [key]: value }));
  const protectedTier = data.tier === "PROTECTED";
  const ecs = !data.site.static;
  const permissions = protection.codePermissions;
  return (
    <Section
      icon={ShieldAlert}
      title="Protection settings"
      subtitle="Everything here applies to the live site immediately unless noted. Pro = needs the Protected tier (AWS WAF)."
      right={<Button size="sm" icon={Save} loading={busy === "settings"} disabled={Boolean(busy)} onClick={() => onSave({ ...draft, walletBudgetUsd: Number(draft.walletBudgetUsd || 0) })}>Save settings</Button>}
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Toggle label="Automatic incident response" help="Lets SkyForge act on incidents: Under Attack mode on spikes or leaked canary keys, container restart when the site goes down, bans." checked={draft.autoResponse} onChange={set("autoResponse")} />
        <Toggle label="Deception: decoy secrets + honey credentials + robots.txt bait" help="Serves fake .env / AWS credential files holding a key with no permissions. Anyone who uses it is an attacker; you get alerted with where they used it. Static sites: always available; app sites: Pro." checked={draft.deception} onChange={set("deception")} />
        <Toggle label="Herd immunity (shared attacker list)" help="IPs banned on any SkyForge project are blocked on this one for 7 days, before they attack it." badge="Pro" checked={draft.herdImmunity} onChange={set("herdImmunity")} disabled={!protectedTier} />
        <Toggle label="Self-tuning rate limits" help={`Learns your real traffic and sets per-IP limits to 3× your busiest real visitor.${protection.tuning?.limits ? ` Now: ${protection.tuning.limits.global}/5 min, login ${protection.tuning.limits.login}/5 min.` : protection.tuning?.note ? ` ${protection.tuning.note}` : ""}`} badge="Pro" checked={draft.selfTuningLimits} onChange={set("selfTuningLimits")} disabled={!protectedTier} />
        <Choice label="Bot challenge" help="A silent JavaScript proof-of-work for HTML page loads (APIs and assets are never challenged). Under Attack mode always uses 'all pages'." badge="Pro" value={draft.botChallenge} options={[["off", "Off"], ["login", "Login pages"], ["all", "All pages"]]} onChange={set("botChallenge")} />
        <Choice label="Security gate" help="Checks the code (hard-coded keys, private keys) and the image's critical CVEs before the new version gets any traffic." value={draft.securityGate} options={[["off", "Off"], ["warn", "Warn"], ["block", "Block deploy"]]} onChange={set("securityGate")} />
        <div className="flex flex-col gap-1 rounded-xl border border-[#EADFCF] bg-white p-3 lg:col-span-2">
          <span className="text-sm font-semibold text-[#362217] flex items-center gap-2">Admin lockdown <span className="px-1.5 py-0.5 rounded bg-[#9E5D2D]/10 text-[#9E5D2D] text-[10px] font-bold uppercase">Pro</span></span>
          <span className="text-[11px] text-[#5E4C3E]">Admin routes ({(protection.firewall?.adminPaths?.length ? protection.firewall.adminPaths : ["/admin", "…from your code"]).join(", ")}) answer 404 except from these IPs/CIDR ranges. Leave empty to turn off. Your IP must be listed or use the admin door.</span>
          <textarea value={draft.adminAllowIps} onChange={(event) => set("adminAllowIps")(event.target.value)} placeholder="203.0.113.10, 198.51.100.0/24" rows={2} className="mt-1 rounded-lg border border-[#EADFCF] bg-white px-3 py-2 text-xs font-mono text-[#362217]" disabled={!protectedTier} />
        </div>
        <Toggle label="Rotating admin door" help="Admin routes are hidden (404) unless the visitor first opens a secret link that rotates every 24 hours. The new link is sent to your alert channels." badge="Pro" checked={draft.adminDoor} onChange={set("adminDoor")} disabled={!protectedTier} />
        <Toggle label="Outbound firewall (code-aware)" help={`The container may only connect out on the ports your code needs${protection.egressPorts ? ` (detected: TCP ${protection.egressPorts.join(", ")})` : ""}. Blocks reverse shells and crypto-miner pools. Takes effect instantly.`} checked={draft.egressLockdown} onChange={set("egressLockdown")} disabled={!ecs} />
        <Toggle label="Tamper-proof container (read-only filesystem)" help="Attackers cannot drop web shells or modify code at runtime. Scratch space stays writable in /tmp. If the app cannot start read-only, SkyForge redeploys it writable and tells you. Applies on the next deploy." checked={draft.readOnlyRoot} onChange={set("readOnlyRoot")} disabled={!ecs} />
        <Toggle label="AWS permissions generated from the code" help={permissions?.actions?.length ? `The container's AWS role gets exactly: ${permissions.actions.join(", ")}.` : "No AWS SDK calls found in the code, so the container gets no AWS permissions (already least privilege)."} checked={draft.applyCodePermissions} onChange={set("applyCodePermissions")} disabled={!ecs || !permissions?.policy} />
        <Toggle label="Leak watch" help="Every 6 hours, checks the site's pages and JavaScript for your real secret values, provider keys and the canary key." checked={draft.leakWatch} onChange={set("leakWatch")} />
        <Toggle label="Take the site offline when a secret leaks" help="Automatic response for leak watch: show the maintenance page until you rotate the secret." checked={draft.leakAutoOffline} onChange={set("leakAutoOffline")} disabled={!draft.leakWatch} />
        <Toggle label="New-CVE alerts (OSV)" help={`Daily check of your dependencies against the OSV vulnerability database.${protection.cve ? ` Last: ${when(protection.cve.checkedAt)}, ${protection.cve.open} known issue(s) in ${protection.cve.packages} packages.` : ""}`} checked={draft.cveWatch} onChange={set("cveWatch")} />
        <Toggle label="Push-time secret detection" help={`Scans every new commit on ${data.branch || "the deployed branch"} for keys and committed .env/.pem files within ~10 minutes.${protection.pushWatch ? ` Last: ${when(protection.pushWatch.checkedAt)}.` : ""}`} checked={draft.pushSecretWatch} onChange={set("pushSecretWatch")} />
        <div className="flex flex-col gap-1 rounded-xl border border-[#EADFCF] bg-white p-3 lg:col-span-2">
          <span className="text-sm font-semibold text-[#362217]">Denial-of-wallet guard</span>
          <span className="text-[11px] text-[#5E4C3E]">Projects your monthly AWS bill from the last 24 hours of traffic every hour. Over budget: alert + Under Attack mode (Pro). Hard stop: take the site offline at 150% of budget.{protection.wallet ? ` Current projection: $${protection.wallet.total}/month.` : ""}</span>
          <div className="flex flex-wrap items-center gap-3 mt-1">
            <label className="flex items-center gap-2 text-xs text-[#5E4C3E]">Budget $<input type="number" min="0" step="1" value={draft.walletBudgetUsd} onChange={(event) => set("walletBudgetUsd")(event.target.value)} className="w-24 rounded-lg border border-[#EADFCF] px-2 py-1 text-xs" /> /month (0 = off)</label>
            <label className="flex items-center gap-2 text-xs text-[#5E4C3E]"><input type="checkbox" className="accent-[#9E5D2D]" checked={draft.walletHardStop} onChange={(event) => set("walletHardStop")(event.target.checked)} /> Hard stop</label>
          </div>
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- deception + door

export function DeceptionPanel({ data, onRotateDoor, busy }) {
  const protection = data.protection || {};
  const firewall = protection.firewall || {};
  const honey = protection.honey;
  const [copied, setCopied] = useState(false);
  const decoys = data.site.static ? protection.staticDecoys.map((key) => `/${key}`) : firewall.decoyPaths || [];
  return (
    <Section icon={Fingerprint} title="Deception & admin door" subtitle="Traps that only attackers touch, and the hidden way into your admin area.">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs text-[#5E4C3E]">
        <div className="flex flex-col gap-2">
          <span className="font-bold text-[#362217]">Decoy files ({decoys.length})</span>
          {decoys.length ? <span className="font-mono break-words">{decoys.join("  ")}</span> : <span className="text-[#8C7667]">{protection.settings?.deception ? (data.site.static ? "Planted on the next deployment." : "Needs the Protected tier on app sites.") : "Deception is off."}</span>}
          {firewall.robots && <span><strong>robots.txt bait:</strong> lists trap folders; anyone who visits them is banned.</span>}
          <span className="font-bold text-[#362217] mt-1">Honey credential</span>
          {honey ? (honey.status?.used
            ? <span className="font-bold text-[#9E2A2B]">USED by an attacker {when(honey.status.lastUsedAt)}{honey.status.region ? ` in ${honey.status.region}` : ""}{honey.status.service ? ` against ${honey.status.service}` : ""}. It has no permissions, nothing was exposed.</span>
            : <span>Armed ({honey.accessKeyId.slice(0, 8)}…), never used. Checked {when(honey.status?.checkedAt)}.</span>) : <span className="text-[#8C7667]">Created with the first decoy.</span>}
          {protection.sharedBanCount > 0 && <span><strong>Herd immunity:</strong> {protection.sharedBanCount} attacker IP(s) from other projects blocked here.</span>}
        </div>
        <div className="flex flex-col gap-2">
          <span className="font-bold text-[#362217] flex items-center gap-1"><DoorOpen className="h-4 w-4" /> Admin door</span>
          {protection.door ? (
            <>
              <span>Open this link once to unlock {(firewall.adminPaths || ["/admin"]).join(", ")} for 24 hours in your browser. Rotated {when(protection.door.rotatedAt)}.</span>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 truncate rounded-lg bg-[#FAF8F5] border border-[#EAE1D5] px-2 py-1 font-mono text-[11px] text-[#362217]">{protection.door.url}</code>
                <Button size="sm" variant="outline" icon={Copy} onClick={() => { void navigator.clipboard?.writeText(protection.door.url); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</Button>
              </div>
              <Button size="sm" variant="outline" icon={Repeat} loading={busy === "door"} disabled={Boolean(busy)} onClick={onRotateDoor} className="self-start">Rotate now</Button>
            </>
          ) : <span className="text-[#8C7667]">Off. Turn on "Rotating admin door" (Protected tier) to hide the admin area behind a secret link.</span>}
          {firewall.botChallenge && firewall.botChallenge !== "off" && <span><strong>Bot challenge:</strong> {firewall.botChallenge === "all" ? "all page loads" : "login pages"}.</span>}
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- tools

export function SecurityToolsPanel({ data, onReplay, onRedTeam, onBlastRadius, onCost, busy, results }) {
  const protection = data.protection || {};
  const redTeam = results.redTeam || protection.redTeam;
  const replay = results.replay || protection.replay;
  const blast = results.blast;
  const cost = results.cost || protection.wallet;
  const live = data.site.live && !data.site.offline;
  return (
    <Section icon={Swords} title="Security tools" subtitle="Owner-initiated checks against your own live site. Every probe is read-only (GET/HEAD/OPTIONS) and rate-limited.">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={Target} loading={busy === "redteam"} disabled={Boolean(busy) || !live} onClick={onRedTeam}>AI red-team rehearsal</Button>
        <Button size="sm" variant="outline" icon={Repeat} loading={busy === "replay"} disabled={Boolean(busy) || !live || data.tier !== "PROTECTED"} onClick={onReplay}>Replay blocked attacks</Button>
        <Button size="sm" variant="outline" icon={Radar} loading={busy === "blast"} disabled={Boolean(busy)} onClick={onBlastRadius}>Blast-radius map</Button>
        <Button size="sm" variant="outline" icon={PiggyBank} loading={busy === "cost"} disabled={Boolean(busy) || !data.site.live} onClick={onCost}>Cost projection</Button>
      </div>

      {redTeam && (
        <div className="flex flex-col gap-2 rounded-xl border border-[#EADFCF] p-3">
          <span className="text-sm font-bold text-[#362217] flex items-center gap-2"><Target className="h-4 w-4 text-[#9E5D2D]" /> Red team · {redTeam.planner} · {redTeam.requests} requests · {when(redTeam.at)}</span>
          <span className="text-[11px] text-[#5E4C3E]">{redTeam.reasoning}</span>
          {redTeam.findings.length ? redTeam.findings.map((item) => (
            <div key={`${item.check}${item.route}`} className="text-xs flex flex-col gap-0.5">
              <span className="flex items-center gap-2"><span className={`px-2 py-0.5 rounded border text-[10px] font-bold uppercase ${SEVERITY_STYLE[item.severity]}`}>{item.severity}</span><strong className="text-[#362217]">{item.title}</strong></span>
              <span className="text-[#5E4C3E]">{item.detail}</span>
              <span className="text-[#2E6B4F]"><strong>Fix:</strong> {item.fix}</span>
            </div>
          )) : <span className="text-xs text-[#2E6B4F] flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> No weaknesses found in {redTeam.plan.length} targeted checks.</span>}
        </div>
      )}

      {replay && (
        <div className="flex flex-col gap-2 rounded-xl border border-[#EADFCF] p-3">
          <span className="text-sm font-bold text-[#362217] flex items-center gap-2"><Repeat className="h-4 w-4 text-[#9E5D2D]" /> Attack replay · {replay.replayed} path(s) · {when(replay.at)}</span>
          {replay.note && <span className="text-xs text-[#8C7667]">{replay.note}</span>}
          <ul className="text-xs flex flex-col gap-1">
            {replay.results?.slice(0, 20).map((item) => (
              <li key={item.path} className="flex flex-wrap items-center gap-2">
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${item.outcome === "vulnerable" ? "bg-[#9E2A2B]/10 text-[#9E2A2B]" : "bg-[#2E6B4F]/10 text-[#2E6B4F]"}`}>{item.outcome}</span>
                <span className="font-mono text-[#362217] break-all">{item.path}</span>
                <span className="text-[#8C7667]">HTTP {item.status ?? "–"}{item.detail ? ` · ${item.detail}` : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {blast && (
        <div className="flex flex-col gap-2 rounded-xl border border-[#EADFCF] p-3">
          <span className="text-sm font-bold text-[#362217] flex items-center gap-2"><Radar className="h-4 w-4 text-[#9E5D2D]" /> Blast radius: <span className={blast.level === "high" ? "text-[#9E2A2B]" : blast.level === "medium" ? "text-amber-700" : "text-[#2E6B4F]"}>{blast.level}</span> ({blast.score}/100)</span>
          <span className="text-[11px] text-[#5E4C3E]">If an attacker fully controlled your container, this is what they could reach:</span>
          <div className="flex flex-wrap gap-1.5">
            {blast.nodes.filter((node) => node.kind !== "origin").map((node) => {
              const Icon = { secret: Lock, data: Layers, aws: Activity, network: Network, canary: Eye }[node.kind] || Activity;
              return <span key={node.id} className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] ${node.kind === "secret" ? "border-[#9E2A2B]/30 text-[#9E2A2B]" : node.kind === "canary" ? "border-[#2E6B4F]/30 text-[#2E6B4F]" : "border-[#EADFCF] text-[#362217]"}`}><Icon className="h-3 w-3" />{node.label}</span>;
            })}
          </div>
          {blast.advice.map((line) => <span key={line} className="text-xs text-[#9E5D2D] flex items-start gap-1"><AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />{line}</span>)}
        </div>
      )}

      {cost && (
        <div className="flex flex-col gap-1 rounded-xl border border-[#EADFCF] p-3 text-xs text-[#5E4C3E]">
          <span className="text-sm font-bold text-[#362217] flex items-center gap-2"><PiggyBank className="h-4 w-4 text-[#9E5D2D]" /> Projected ${cost.total}/month (fixed ${cost.fixed} + traffic ${cost.variable})</span>
          <span>Last 24h: {Math.round(cost.requests24h || 0).toLocaleString()} requests, {((cost.bytes24h || 0) / 1e6).toFixed(1)} MB{cost.edgeRequests24h ? `, CloudFront ${Math.round(cost.edgeRequests24h).toLocaleString()} requests` : ""}.{cost.budget ? ` Budget $${cost.budget}.` : ""}</span>
          {cost.note && <span className="text-[#8C7667]">{cost.note}</span>}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- attack surface

export function SurfacePanel({ data }) {
  const protection = data.protection || {};
  const diff = protection.surfaceDiff;
  const surface = protection.surface;
  if (!surface) return null;
  return (
    <Section icon={FileWarning} title="Attack surface" subtitle="Captured from the code on every deploy and compared with the previous deploy.">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        {[["Routes", surface.routes], ["Admin routes", surface.adminRoutes?.length], ["Login routes", surface.loginRoutes?.length], ["Packages", surface.dependencies]].map(([label, value]) => (
          <div key={label} className="rounded-xl bg-[#FAF8F5] border border-[#EAE1D5] p-3"><div className="text-[11px] text-[#8C7667]">{label}</div><div className="text-lg font-bold text-[#362217]">{value ?? 0}</div></div>
        ))}
      </div>
      {diff && !diff.first && (
        <div className="text-xs text-[#5E4C3E] flex flex-col gap-1">
          <span className="font-bold text-[#362217]">Last deploy changed the surface: <span className={diff.risk === "high" ? "text-[#9E2A2B]" : diff.risk === "medium" ? "text-amber-700" : "text-[#2E6B4F]"}>{diff.risk} risk</span></span>
          {diff.highlights.length ? diff.highlights.map((line) => <span key={line} className="flex items-start gap-1"><GitCommit className="h-3.5 w-3.5 mt-0.5 shrink-0 text-[#9E5D2D]" />{line}</span>) : <span>No changes.</span>}
        </div>
      )}
      {surface.debugRoutes?.length > 0 && <span className="text-xs text-amber-700">Debug/internal routes in the code: <span className="font-mono">{surface.debugRoutes.slice(0, 10).join("  ")}</span></span>}
    </Section>
  );
}
