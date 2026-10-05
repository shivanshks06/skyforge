import { useEffect, useState } from "react";
import { CheckCircle2, Cloud, Database, Link2 } from "lucide-react";
import Card from "./Card";
import { getProjectDatabase, saveProjectDatabase } from "../services/api";

const OPTIONS = [
  {
    mode: "external",
    icon: Link2,
    title: "Use my own database URL",
    text: "Paste a connection string (Neon, Supabase, PlanetScale, your own RDS...) as DATABASE_URL below. No database cost on your AWS bill.",
  },
  {
    mode: "rds",
    icon: Cloud,
    title: "Create one for me on AWS (RDS)",
    text: "SkyForge creates a private, encrypted database in your AWS account on the next deploy and sets DATABASE_URL automatically. Destroying the project deletes it.",
  },
];

/** How the app gets its database. Calls onChange(mode, engine) so the variable list can adapt. */
export default function DatabaseCard({ projectId, needed, onChange, onNotify }) {
  const [state, setState] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getProjectDatabase(projectId)
      .then((data) => {
        if (cancelled) return;
        setState(data);
        onChange?.(data.database.mode || "external", data.database.engine || "postgres");
      })
      .catch(() => {
        if (!cancelled) setState({ database: { mode: "external" }, engines: { postgres: "PostgreSQL 16", mysql: "MySQL 8.0" }, monthlyCost: "" });
      });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (!state) return null;
  const database = state.database || { mode: "external" };
  const engine = database.engine || "postgres";

  const choose = async (mode, nextEngine = engine) => {
    setSaving(true);
    try {
      const result = await saveProjectDatabase(projectId, { mode, engine: nextEngine });
      setState({ ...state, database: result.database });
      onChange?.(mode, nextEngine);
      onNotify?.(result.message, "success");
    } catch (err) {
      onNotify?.(err.response?.data?.message || "Could not change the database setting.", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card glow={false} className="flex flex-col gap-4 bg-white border border-[#EAE1D5]">
      <div className="flex items-start gap-2 border-b border-[#EADFCF] pb-3">
        <Database className="h-5 w-5 text-[#9E5D2D] mt-0.5" />
        <div>
          <h3 className="text-base font-bold text-[#362217]">Database</h3>
          <p className="text-xs text-[#5E4C3E]">
            {needed ? "This app uses a database. On AWS it must be a hosted database, not localhost." : "Only needed if your app stores data in a database."}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {OPTIONS.map((option) => {
          const active = database.mode === option.mode || (!database.mode && option.mode === "external");
          const Icon = option.icon;
          return (
            <button
              key={option.mode}
              type="button"
              disabled={saving}
              aria-pressed={active}
              onClick={() => !active && choose(option.mode)}
              className={`text-left rounded-2xl border-2 p-4 flex flex-col gap-2 transition disabled:opacity-70 ${active ? "border-[#9E5D2D] bg-[#FFFBF6] ring-2 ring-[#9E5D2D]/15" : "border-[#EADFCF] bg-white hover:border-[#8C7667]"}`}
            >
              <span className="flex items-center justify-between gap-2 text-sm font-bold text-[#362217]">
                <span className="flex items-center gap-2"><Icon className="h-4 w-4 text-[#9E5D2D]" /> {option.title}</span>
                {active && <CheckCircle2 className="h-4 w-4 text-[#9E5D2D]" />}
              </span>
              <span className="text-xs text-[#5E4C3E]">{option.text}</span>
              {option.mode === "rds" && <span className="text-[11px] font-mono text-[#8C7667]">{state.monthlyCost}</span>}
            </button>
          );
        })}
      </div>
      {database.mode === "rds" && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-[#5E4C3E]">
          <label className="flex items-center gap-2">
            Engine
            <select
              value={engine}
              disabled={saving || Boolean(database.identifier)}
              onChange={(event) => choose("rds", event.target.value)}
              className="rounded-lg border border-[#EADFCF] bg-white px-2 py-1 text-xs text-[#362217]"
            >
              {Object.entries(state.engines || {}).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          {database.status === "available" ? (
            <span className="text-[#2E6B4F] font-semibold">Running: {database.identifier} ({database.endpoint})</span>
          ) : database.status === "creating" ? (
            <span className="text-amber-700">Being created ({database.identifier})...</span>
          ) : (
            <span className="text-[#8C7667]">Created on the next deploy (first time about 5-10 minutes).</span>
          )}
          <span className="w-full text-[11px] text-[#8C7667]">DATABASE_URL, DB_HOST/DB_USER/DB_PASSWORD/DB_NAME and the {engine === "mysql" ? "MYSQL_*" : "PG*/POSTGRES_*"} variables are set for the app automatically. One-Click Destroy deletes the database and its data.</span>
        </div>
      )}
    </Card>
  );
}
