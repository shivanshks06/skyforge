import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowRight, CheckCircle2, GitBranch, Loader2, Rocket, Search } from "lucide-react";
import Card from "../components/Card";
import Button from "../components/Button";
import TargetChooser from "../components/TargetChooser";
import DatabaseCard from "../components/DatabaseCard";
import BuildLocationCard from "../components/BuildLocationCard";
import {
  analyzeRepository, createProject, getGithubRepos, getProjectById, getProjectInfrastructure, getProjects,
  saveProjectEnvVars, triggerProjectDeployment, updateProjectInfrastructureTarget, getProjectCostPreview,
} from "../services/api";

const DB_KEYS = /^(DATABASE_URL|DB_|POSTGRES|PG(HOST|USER|PASSWORD|DATABASE|PORT)|MYSQL)/;

function parseRepository(value) {
  const text = String(value || "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const match = text.match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/tree\/([\w./-]+))?$/i);
  return match ? { owner: match[1], repo: match[2], branch: match[3] || "" } : null;
}

function Step({ number, title, done, active, children }) {
  return (
    <Card glow={false} className={`flex flex-col gap-4 border bg-white transition ${active ? "border-[#9E5D2D]/40 ring-2 ring-[#9E5D2D]/10" : "border-[#EAE1D5]"} ${!done && !active ? "opacity-55" : ""}`}>
      <div className="flex items-center gap-3">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${done ? "bg-[#2E6B4F] text-white" : active ? "bg-[#9E5D2D] text-white" : "bg-[#F0E7DC] text-[#8C7667]"}`}>
          {done ? <CheckCircle2 className="h-4 w-4" /> : number}
        </span>
        <h2 className="text-base font-bold text-[#362217]">{title}</h2>
      </div>
      {(active || done) && children}
    </Card>
  );
}

/** Guided "deploy a new site": repository → where to deploy → what the app needs → review and deploy. */
export default function NewDeployment() {
  const navigate = useNavigate();
  const [repos, setRepos] = useState(null);
  const [existing, setExisting] = useState([]);
  const [repoInput, setRepoInput] = useState("");
  const [filter, setFilter] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [project, setProject] = useState(null);
  const [infra, setInfra] = useState(null);
  const [envValues, setEnvValues] = useState({});
  const [envSaved, setEnvSaved] = useState(false);
  const [database, setDatabase] = useState({ mode: "external", engine: "postgres" });
  const [blockers, setBlockers] = useState([]);

  useEffect(() => {
    getGithubRepos().then((data) => setRepos(Array.isArray(data) ? data : [])).catch(() => setRepos([]));
    getProjects().then((data) => setExisting(Array.isArray(data) ? data : [])).catch(() => {});
  }, []);

  const run = async (key, action) => {
    setBusy(key);
    setError(null);
    try {
      return await action();
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Something went wrong.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  const analyze = (value) => run("analyze", async () => {
    const parsed = parseRepository(value);
    if (!parsed) throw new Error("Enter a repository as owner/name or a GitHub link.");
    setRepoInput(`${parsed.owner}/${parsed.repo}`);
    const report = await analyzeRepository({ owner: parsed.owner, repo: parsed.repo, branch: parsed.branch });
    setAnalysis({ ...report, owner: parsed.owner, repo: parsed.repo });
  });

  const already = useMemo(() => {
    if (!analysis) return null;
    const name = `${analysis.owner}/${analysis.repo}`.toLowerCase();
    return existing.find((item) => String(item.repoName).toLowerCase() === name && (item.branch || "main") === analysis.branch) || null;
  }, [analysis, existing]);

  const loadProject = async (id) => {
    const [full, infrastructure] = await Promise.all([getProjectById(id), getProjectInfrastructure(id)]);
    setProject(full);
    setInfra(infrastructure);
  };

  const create = () => run("create", async () => {
    if (already) return loadProject(already.id);
    const found = analysis.detection;
    const created = await createProject({
      name: analysis.repo.toLowerCase(),
      repoName: `${analysis.owner}/${analysis.repo}`,
      branch: analysis.branch,
      framework: found.framework,
      language: found.language,
      packageManager: found.packageManager,
      buildTool: found.buildTool,
      buildCommand: found.buildCommand,
      startCommand: found.startCommand,
      port: Number(found.port) || 80,
      dockerized: Boolean(found.dockerized),
      requiredEnv: found.requiredEnv || [],
      ...(found.envAnalysis ? { envAnalysis: found.envAnalysis } : {}),
      confidence: found.confidence ?? 80,
      githubUrl: `https://github.com/${analysis.owner}/${analysis.repo}`,
    });
    await loadProject(created.id);
  });

  const chooseTarget = (target) => run("target", async () => {
    const result = await updateProjectInfrastructureTarget(project.id, target);
    setInfra(result);
    setProject(await getProjectById(project.id));
  });

  const variables = useMemo(() => {
    const list = project?.envAnalysis?.variables || (project?.requiredEnv || []).map((name) => ({ name, required: true }));
    return list.filter((variable) => variable.required);
  }, [project]);
  const providedByDatabase = (name) => database.mode === "rds" && DB_KEYS.test(name);
  const missing = variables.filter((variable) => !providedByDatabase(variable.name) && !String(envValues[variable.name] ?? project?.envConfig?.[variable.name] ?? "").trim());
  const needsDatabase = (project?.envAnalysis?.services || []).some((service) => /postgres|mysql|maria|sql/i.test(`${service.id} ${service.label}`)) || variables.some((variable) => DB_KEYS.test(variable.name));
  const isStatic = infra?.target === "AWS_S3_CLOUDFRONT";

  const saveSettings = () => run("env", async () => {
    const values = Object.fromEntries(Object.entries(envValues).filter(([, value]) => String(value).trim()));
    if (Object.keys(values).length) await saveProjectEnvVars(project.id, values);
    setEnvSaved(true);
  });

  const deploy = () => run("deploy", async () => {
    setBlockers([]);
    try {
      const result = await triggerProjectDeployment(project.id);
      navigate(`/project/${project.id}/deploy?deploymentId=${encodeURIComponent(result.deploymentId)}`);
    } catch (err) {
      if (err.response?.data?.blockers) {
        setBlockers(err.response.data.blockers);
        return;
      }
      throw err;
    }
  });

  const step = !project ? 1 : !infra?.target ? 2 : !envSaved ? 3 : 4;

  // What it will cost to keep running, shown before the person presses Deploy.
  const costKey = step === 4 && project ? `${project.id}:${infra?.target}:${database.mode}` : null;
  const [cost, setCost] = useState({ key: null, value: null });
  useEffect(() => {
    if (!costKey || cost.key === costKey) return undefined;
    let cancelled = false;
    getProjectCostPreview(costKey.split(":")[0]).then((result) => !cancelled && setCost({ key: costKey, value: result.cost })).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [costKey, cost.key]);
  const costPreview = cost.key === costKey ? cost.value : null;
  const shownRepos = (repos || []).filter((repo) => `${repo.fullName || ""} ${repo.name} ${repo.language || ""}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 12);
  const found = analysis?.detection;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 pb-16">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-[#362217]"><Rocket className="h-6 w-6 text-[#9E5D2D]" /> Deploy a new site</h1>
        <p className="text-sm text-[#5E4C3E]">Four steps, one page. SkyForge fills in everything it can detect; you only confirm and add what it cannot know (like API keys).</p>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-[#9E2A2B]/30 bg-[#9E2A2B]/5 p-3 text-xs text-[#9E2A2B]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      <Step number={1} title="Choose a repository" done={step > 1} active={step === 1}>
        {step > 1 ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-[#5E4C3E]">
            <strong className="text-[#362217]">{project.repoName}</strong> <GitBranch className="h-3.5 w-3.5" /> {project.branch} · {project.framework} · port {project.port}
          </p>
        ) : (
          <>
            <form onSubmit={(event) => { event.preventDefault(); void analyze(repoInput); }} className="flex flex-col gap-2 sm:flex-row">
              <input
                value={repoInput}
                onChange={(event) => setRepoInput(event.target.value)}
                placeholder="owner/repository or https://github.com/owner/repository"
                className="flex-1 rounded-xl border border-[#DCD0C3] bg-white px-3 py-2.5 text-sm text-[#362217] outline-none focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D]"
                aria-label="Repository"
              />
              <Button type="submit" icon={Search} loading={busy === "analyze"}>Detect</Button>
            </form>

            {repos?.length > 0 && !analysis && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[#8C7667]">Or pick one of your GitHub repositories</span>
                  <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter…" className="w-40 rounded-lg border border-[#EADFCF] px-2 py-1 text-xs" aria-label="Filter repositories" />
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {shownRepos.map((repo) => (
                    <button key={repo.id} type="button" disabled={Boolean(busy)} onClick={() => analyze(repo.fullName || `${repo.owner}/${repo.name}`)} className="lift flex items-center justify-between gap-2 rounded-xl border border-[#EADFCF] bg-[#FFFBF6] px-3 py-2 text-left disabled:opacity-60">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-[#362217]">{repo.name}</span>
                        <span className="block truncate text-[11px] text-[#8C7667]">{repo.language || "Unknown language"} · {repo.private ? "Private" : "Public"}</span>
                      </span>
                      <ArrowRight className="h-4 w-4 shrink-0 text-[#9E5D2D]" />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {repos === null && <div className="skeleton h-16 w-full" />}

            {busy === "analyze" && <p className="flex items-center gap-2 text-xs text-[#5E4C3E]"><Loader2 className="h-4 w-4 animate-spin" /> Reading the repository and detecting how to build it…</p>}

            {analysis && found && (
              <div className="page-enter flex flex-col gap-3 rounded-2xl border border-[#2E6B4F]/20 bg-[#2E6B4F]/5 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-[#2E6B4F]"><CheckCircle2 className="h-4 w-4" /> Detected {found.framework} ({found.language})</p>
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  {[`Branch ${analysis.branch}`, `Port ${found.port}`, found.dockerized ? "Has a Dockerfile" : "Dockerfile generated by SkyForge", found.appDirectory ? `App in ${found.appDirectory}/` : null, found.requiredEnv?.length ? `${found.requiredEnv.length} setting(s) needed` : "No required settings"].filter(Boolean).map((text) => (
                    <span key={text} className="rounded-full border border-[#2E6B4F]/20 bg-white px-2.5 py-0.5 text-[#2E6B4F]">{text}</span>
                  ))}
                </div>
                {already && <p className="text-xs text-[#5E4C3E]">You already imported this repository as <strong>{already.name}</strong>; continuing uses that project.</p>}
                <div className="flex gap-2">
                  <Button icon={ArrowRight} loading={busy === "create"} onClick={create}>{already ? "Continue with it" : "Create project"}</Button>
                  <Button variant="outline" onClick={() => { setAnalysis(null); setRepoInput(""); }}>Choose another</Button>
                </div>
              </div>
            )}
          </>
        )}
      </Step>

      <Step number={2} title="Choose where to deploy" done={step > 2} active={step === 2}>
        {infra && <TargetChooser choices={infra.choices || []} selected={infra.target} onChoose={chooseTarget} busy={busy === "target"} />}
      </Step>

      <Step number={3} title="Give the app what it needs" done={step > 3} active={step === 3}>
        {project && (
          <div className="flex flex-col gap-4">
            {needsDatabase && !isStatic && <DatabaseCard projectId={project.id} needed onChange={(mode, engine) => setDatabase({ mode, engine })} />}
            {variables.length > 0 ? (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-semibold text-[#362217]">Settings the code requires</span>
                <p className="text-xs text-[#5E4C3E]">Values are encrypted and given to the app through AWS Secrets Manager. They are never shown again or put in the code.</p>
                {variables.map((variable) => (
                  <label key={variable.name} className="flex flex-col gap-1">
                    <span className="font-mono text-xs font-semibold text-[#362217]">{variable.name}{variable.locations?.[0] ? <span className="font-sans font-normal text-[#8C7667]"> · used in {variable.locations[0]}</span> : null}</span>
                    {providedByDatabase(variable.name) ? (
                      <span className="text-xs text-[#2E6B4F]">Set automatically by the SkyForge database</span>
                    ) : (
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={envValues[variable.name] ?? ""}
                        placeholder={project.envConfig?.[variable.name] ? "Already set (leave empty to keep)" : `Enter ${variable.name}`}
                        onChange={(event) => setEnvValues({ ...envValues, [variable.name]: event.target.value })}
                        className="rounded-xl border border-[#DCD0C3] bg-white px-3 py-2 font-mono text-xs outline-none focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D]"
                      />
                    )}
                  </label>
                ))}
                <Link to={`/project/${project.id}/plan`} className="text-[11px] font-semibold text-[#9E5D2D] hover:underline">See all detected settings (including optional ones) →</Link>
              </div>
            ) : (
              <p className="text-sm text-[#5E4C3E]">The code does not require any settings. You can still add some later on the Environment page.</p>
            )}
            {!isStatic && <BuildLocationCard projectId={project.id} initialMode={project.buildMode} />}
            <div className="flex items-center gap-3">
              <Button icon={ArrowRight} loading={busy === "env"} onClick={saveSettings}>{missing.length ? `Continue (${missing.length} still empty)` : "Continue"}</Button>
              {missing.length > 0 && <span className="text-[11px] text-amber-700">Deployment is blocked until required settings are filled in or marked not needed.</span>}
            </div>
          </div>
        )}
      </Step>

      <Step number={4} title="Review and deploy" done={false} active={step === 4}>
        {project && infra?.target && (
          <div className="flex flex-col gap-3">
            <dl className="grid grid-cols-1 gap-2 rounded-2xl bg-[#FAF8F5] p-4 text-xs sm:grid-cols-2">
              {[
                ["Repository", `${project.repoName} (${project.branch})`],
                ["App", `${project.framework} on port ${project.port}`],
                ["Target", (infra.choices || []).find((choice) => choice.id === infra.target)?.label || infra.target],
                ["Estimated cost", costPreview ? `About $${costPreview.daily.toFixed(2)}/day ($${costPreview.monthly}/month) while running` : infra.costEstimation?.total || (infra.choices || []).find((choice) => choice.id === infra.target)?.cost || "See Infrastructure page"],
                ["Database", needsDatabase ? (database.mode === "rds" ? "SkyForge-managed (RDS)" : "Your own URL") : "Not needed"],
                ["Settings", variables.length ? `${variables.length - missing.length}/${variables.length} required set` : "None required"],
              ].map(([label, value]) => (
                <div key={label}><dt className="font-semibold text-[#8C7667]">{label}</dt><dd className="text-[#362217]">{String(value)}</dd></div>
              ))}
            </dl>
            {blockers.length > 0 && (
              <ul className="flex flex-col gap-1 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800">
                {blockers.map((blocker) => <li key={blocker} className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {blocker}</li>)}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <Button icon={Rocket} loading={busy === "deploy"} onClick={deploy}>Deploy now</Button>
              <Button variant="outline" onClick={() => setEnvSaved(false)}>Back to settings</Button>
            </div>
            {costPreview && <p className="text-[11px] text-[#5E4C3E]">AWS bills your account about <b>${costPreview.daily.toFixed(2)} per day</b> while the site runs. Destroying it later stops all charges; you can also set a monthly budget on the <Link to="/dashboard/costs" className="font-semibold text-[#9E5D2D] hover:underline">Costs</Link> page.</p>}
            <p className="text-[11px] text-[#8C7667]">You will see the live build log next. The first deploy usually takes 5–15 minutes; you get a notification when it is live.</p>
          </div>
        )}
      </Step>
    </div>
  );
}
