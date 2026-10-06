import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, PiggyBank, RefreshCw, Wallet } from "lucide-react";
import { getAccountCosts, saveBudget } from "../services/api";
import { BarChart } from "../components/Charts";
import { Notice, PageHeader, Panel } from "../components/ui";
import { buttonClass, timeAgo } from "../utils/format";

const money = (value) => (value === null || value === undefined ? "—" : `$${Number(value).toFixed(2)}`);

function Stat({ label, value, hint, tone = "text-[#362217]" }) {
  return (
    <div className="rounded-3xl border border-[#EAE1D5] bg-white p-5">
      <p className="text-xs font-semibold text-[#8C7667]">{label}</p>
      <p className={`mt-1 text-3xl font-bold ${tone}`}>{value}</p>
      {hint && <p className="mt-1 text-[11px] text-[#8C7667]">{hint}</p>}
    </div>
  );
}

/** What AWS is charging, which projects cost what, and a monthly budget. */
export default function Costs() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [budget, setBudget] = useState({ monthlyUsd: "", action: "alert" });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);

  const load = async (refresh = false) => {
    setRefreshing(refresh);
    try {
      const result = await getAccountCosts(refresh);
      setData(result);
      if (result.budget) setBudget({ monthlyUsd: String(result.budget.monthlyUsd), action: result.budget.action });
      setError(null);
    } catch (loadError) {
      setError(loadError.response?.data?.message || "Could not load costs.");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, []);

  const spend = data?.spend;
  const limit = Number(data?.budget?.monthlyUsd) || null;
  const used = limit && spend ? Math.min(100, Math.round((spend.monthToDate / limit) * 100)) : null;
  const forecastOver = limit && spend && spend.forecast > limit;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        icon={Wallet}
        title="Costs"
        subtitle="What AWS is charging this month, which sites cost what, and a budget that warns you (or switches sites off) before a surprise bill."
        actions={<button type="button" onClick={() => load(true)} disabled={refreshing} className={buttonClass.secondary} title="Cost Explorer charges $0.01 per refresh; results are otherwise cached for 6 hours">{refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh</button>}
      />

      {error && <Notice kind="error">{error} {/Connect an AWS/.test(error) && <Link to="/dashboard/settings" className="font-semibold text-[#9E5D2D] underline">Connect AWS</Link>}</Notice>}
      {data?.spendError && <Notice kind="warn">{data.spendError}</Notice>}

      {!data && !error && <div className="grid gap-4 sm:grid-cols-3">{[0, 1, 2].map((key) => <div key={key} className="skeleton h-28" />)}</div>}

      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Spent this month" value={money(spend?.monthToDate)} hint={spend ? `Whole AWS account · updated ${timeAgo(spend.fetchedAt)}` : "Needs Cost Explorer access"} />
            <Stat label="Forecast for the month" value={money(spend?.forecast)} tone={forecastOver ? "text-[#9E2A2B]" : "text-[#362217]"} hint={forecastOver ? `Above your $${limit} budget` : "If the rest of the month looks like so far"} />
            <Stat label="Running sites cost about" value={`${money(data.runningDaily)}/day`} hint={`${money(data.runningMonthly)}/month for ${data.projects.length} running site${data.projects.length === 1 ? "" : "s"}`} />
          </div>

          {limit && used !== null && (
            <div className="rounded-3xl border border-[#EAE1D5] bg-white p-5">
              <div className="mb-2 flex items-center justify-between text-xs font-semibold text-[#5E4C3E]">
                <span>Budget used</span>
                <span>{money(spend.monthToDate)} of {money(limit)} ({used}%)</span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-[#F0E7DC]">
                <div className="h-full rounded-full transition-all" style={{ width: `${used}%`, background: used >= 100 ? "#C2412D" : used >= 80 ? "#D97706" : "#2E6B4F" }} />
              </div>
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <Panel title="Daily spend" description="All AWS services in this account, per day this month.">
              <BarChart bars={(spend?.daily || []).map((day) => ({ label: new Date(`${day.date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" }), value: day.amount }))} unit="usd" />
            </Panel>
            <Panel title="By service" description="Where this month's money went.">
              {spend?.byService?.length ? (
                <ul className="flex flex-col gap-2">
                  {spend.byService.slice(0, 8).map((item) => (
                    <li key={item.service} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate text-[#362217]">{item.service.replace(/^Amazon |^AWS /, "")}</span>
                        <span className="font-semibold text-[#362217]">{money(item.amount)}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-[#F0E7DC]"><div className="h-full rounded-full bg-[#9E5D2D]" style={{ width: `${Math.max(2, (item.amount / spend.byService[0].amount) * 100)}%` }} /></div>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-xs text-[#8C7667]">No charges yet this month.</p>}
            </Panel>
          </div>

          <Panel title="Running sites" description="Monthly cost per live site: measured from real traffic when SkyForge has seen it, otherwise an estimate from the site's size.">
            {data.projects.length ? (
              <ul className="divide-y divide-[#F0E7DC]">
                {data.projects.map((project) => (
                  <li key={project.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <Link to={`/project/${project.id}/deploy`} className="truncate text-sm font-semibold text-[#362217] hover:text-[#9E5D2D]">{project.name}</Link>
                      <p className="text-[11px] text-[#8C7667]">{project.preview ? "Pull-request preview · " : ""}{project.offline ? "Offline (load balancer still bills) · " : ""}{project.source}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-[#362217]">{money(project.monthly)}<span className="text-[11px] font-medium text-[#8C7667]">/mo</span></p>
                      <p className="text-[11px] text-[#8C7667]">{money((project.monthly || 0) / 30)}/day</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className="text-xs text-[#8C7667]">No sites are running, so SkyForge projects cost nothing right now.</p>}
            <p className="mt-3 text-[11px] text-[#8C7667]">To stop a site's charges completely, use One-Click Destroy in its console. Taking a site offline stops the container but the load balancer still bills about $0.55/day.</p>
          </Panel>

          <Panel icon={PiggyBank} title="Monthly budget" description="SkyForge compares your AWS spend with this every 6 hours and alerts you at 80%, when the forecast passes it, and when you go over (using the alert channels in Settings).">
            <form
              className="flex flex-col gap-3"
              onSubmit={async (event) => {
                event.preventDefault();
                setSaving(true);
                setSaved(null);
                try {
                  const result = await saveBudget({ monthlyUsd: Number(budget.monthlyUsd || 0), action: budget.action });
                  setData((current) => ({ ...current, budget: result.budget }));
                  setSaved(result.budget ? `Budget saved: $${result.budget.monthlyUsd}/month.` : "Budget turned off.");
                } catch (saveError) {
                  setSaved(saveError.response?.data?.message || "Could not save the budget.");
                } finally {
                  setSaving(false);
                }
              }}
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <label className="flex flex-col gap-1 text-xs font-semibold text-[#5E4C3E]">
                  Budget per month (USD, 0 = off)
                  <div className="flex h-10 items-center rounded-xl border border-[#DCD0C3] bg-white px-3">
                    <span className="text-sm text-[#8C7667]">$</span>
                    <input type="number" min="0" step="1" value={budget.monthlyUsd} onChange={(event) => setBudget({ ...budget, monthlyUsd: event.target.value })} className="w-32 bg-transparent pl-1 text-sm text-[#362217] outline-none" />
                  </div>
                </label>
                <button type="submit" disabled={saving} className={buttonClass.primary}>{saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save budget</button>
              </div>
              <fieldset className="flex flex-col gap-2 text-xs text-[#362217]">
                <legend className="mb-1 font-semibold text-[#5E4C3E]">When spend goes over the budget</legend>
                <label className="flex items-start gap-2"><input type="radio" name="action" checked={budget.action === "alert"} onChange={() => setBudget({ ...budget, action: "alert" })} className="mt-0.5 accent-[#9E5D2D]" /> Alert me only</label>
                <label className="flex items-start gap-2"><input type="radio" name="action" checked={budget.action === "offline"} onChange={() => setBudget({ ...budget, action: "offline" })} className="mt-0.5 accent-[#9E5D2D]" /> Alert me and take every site offline (stops containers; load balancers still bill until you destroy them)</label>
              </fieldset>
              {saved && <p className="text-xs font-semibold text-[#2E6B4F]">{saved}</p>}
            </form>
          </Panel>

          {spend?.note && <p className="text-[11px] text-[#8C7667]">{spend.note}</p>}
        </>
      )}
    </div>
  );
}
