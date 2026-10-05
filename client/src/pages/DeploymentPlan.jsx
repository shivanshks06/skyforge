import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import Card from "../components/Card";
import Button from "../components/Button";
import {
  Cpu,
  Server,
  Cloud,
  Terminal,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  RefreshCw,
  ArrowLeft,
  Sparkles,
  Boxes,
  FileCode,
  Zap,
  Rocket,
  Container
} from "lucide-react";
import { getProjectPlan, generateProjectPlan, saveProjectEnvVars, scanProjectEnv } from "../services/api";
import EnvironmentWizard from "../components/EnvironmentWizard";
import DatabaseCard from "../components/DatabaseCard";

// Variables a SkyForge-managed database provides (kept in sync with server/services/rdsService.js).
const MANAGED_DB_KEYS = {
  postgres: ["DATABASE_URL", "DB_HOST", "DB_PORT", "DB_USER", "DB_USERNAME", "DB_PASSWORD", "DB_NAME", "DB_DATABASE", "POSTGRES_URL", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "POSTGRES_HOST", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"],
  mysql: ["DATABASE_URL", "DB_HOST", "DB_PORT", "DB_USER", "DB_USERNAME", "DB_PASSWORD", "DB_NAME", "DB_DATABASE", "MYSQL_URL", "MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"],
};

export default function DeploymentPlan() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [savingEnv, setSavingEnv] = useState(false);
  const [scanningEnv, setScanningEnv] = useState(false);
  const [projectData, setProjectData] = useState(null);
  const [plan, setPlan] = useState(null);
  const [blueprints, setBlueprints] = useState(null);
  const [envValues, setEnvValues] = useState({});
  const [activeTab, setActiveTab] = useState("docker"); // 'docker' or 'terraform'
  const [copiedCode, setCopiedCode] = useState(false);
  const [toast, setToast] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [databaseMode, setDatabaseMode] = useState({ mode: "external", engine: "postgres" });
  const loadGeneration = useRef(0);
  const toastTimer = useRef(null);

  const showToast = (message, type = "success") => {
    window.clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  };

  const handleScanEnv = async ({ silent = false } = {}) => {
    setScanningEnv(true);
    try {
      const res = await scanProjectEnv(id);
      setProjectData((previous) => ({ ...previous, ...res.project }));
      if (!silent) showToast("Repository re-scanned for environment variables.");
    } catch (err) {
      if (!silent) showToast(err.response?.data?.message || "Could not scan the repository.", "error");
    } finally {
      setScanningEnv(false);
    }
  };

  const loadPlan = async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError(null);
    setProjectData(null);
    setPlan(null);
    setBlueprints(null);
    try {
      const data = await getProjectPlan(id);
      if (generation !== loadGeneration.current) return;
      setProjectData(data.project);
      setPlan(data.plan);
      setBlueprints(data.blueprints);
      setEnvValues(data.project.envConfig || {});
      if (!data.project.envAnalysis) void handleScanEnv({ silent: true });
    } catch (err) {
      if (generation !== loadGeneration.current) return;
      console.error("Failed to load plan:", err);
      setLoadError(err.response?.data?.message || "Unable to load the deployment plan.");
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!id) return undefined;
    const task = window.setTimeout(() => {
      void loadPlan();
    }, 0);
    return () => {
      window.clearTimeout(task);
      loadGeneration.current += 1;
      window.clearTimeout(toastTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      const data = await generateProjectPlan(id);
      setProjectData(data.project);
      setPlan(data.plan);
      setBlueprints(data.blueprints);
      showToast("AI Deployment Plan refreshed successfully!");
    } catch (err) {
      console.error("Failed to regenerate plan:", err);
      showToast(err.response?.data?.message || "Could not regenerate plan.", "error");
    } finally {
      setRegenerating(false);
    }
  };

  const handleSaveEnvVars = async (ignoredEnv) => {
    setSavingEnv(true);
    try {
      const res = await saveProjectEnvVars(id, envValues, ignoredEnv);
      setProjectData(res.project);
      if (res.blueprints) setBlueprints(res.blueprints);
      if (res.warnings?.length) showToast(res.warnings[0], "error");
      else showToast("Environment variables saved! Blueprint updated.");
    } catch (err) {
      console.error("Failed to save environment variables:", err);
      showToast(err.response?.data?.message || "Failed to save environment variables.", "error");
    } finally {
      setSavingEnv(false);
    }
  };

  const handleCopyCode = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      showToast("Clipboard access was denied.", "error");
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center gap-3 w-full">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-[#9E5D2D] border-t-transparent" />
        <h3 className="text-base font-bold text-[#362217]">Synthesizing AI Deployment Blueprint...</h3>
        <p className="text-xs text-[#8C7667]">Analyzing CPU, Memory, Health Checks, and Terraform specifications.</p>
      </div>
    );
  }

  if (loadError || !projectData || !plan) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center" role="alert">
        <AlertCircle className="h-10 w-10 text-[#9E2A2B]" />
        <h2 className="text-lg font-bold text-[#362217]">Deployment plan unavailable</h2>
        <p className="max-w-md text-sm text-[#5E4C3E]">{loadError || "The server returned an incomplete deployment plan."}</p>
        <div className="flex gap-3">
          <Button variant="outline" onClick={() => navigate("/dashboard/projects")}>Back to Projects</Button>
          <Button onClick={loadPlan} icon={RefreshCw}>Retry</Button>
        </div>
      </div>
    );
  }

  const currentStatus = projectData.status || "Planned";

  // State Machine Step Definitions
  const lifecycleSteps = [
    { label: "Imported", done: true },
    { label: "Planned", done: currentStatus !== "Imported" },
    { label: "Containerized", done: ["Containerized", "Configured", "Ready to Deploy", "Live"].includes(currentStatus) },
    { label: "Configured", done: ["Configured", "Ready to Deploy", "Live"].includes(currentStatus) },
    { label: "Ready to Deploy", done: ["Ready to Deploy", "Live"].includes(currentStatus) },
  ];

  return (
    <div className="flex flex-col gap-8 w-full max-w-6xl mx-auto text-[#362217]">
      {/* Toast Notification */}
      {toast && (
        <div
          role={toast.type === "error" ? "alert" : "status"}
          className={`fixed top-6 right-6 z-50 flex items-center gap-2.5 rounded-2xl border bg-white px-5 py-3.5 text-xs font-bold shadow-xl ${
            toast.type === "error" ? "border-[#9E2A2B]/30 text-[#9E2A2B]" : "border-[#2E6B4F]/30 text-[#2E6B4F]"
          }`}
        >
          {toast.type === "error" ? <AlertCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
          <span>{toast.message}</span>
        </div>
      )}

      {/* Top Breadcrumb & Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#EAE1D5] pb-5">
        <div className="flex flex-col gap-1.5">
          <Link
            to="/dashboard/projects"
            className="flex items-center gap-1.5 text-xs font-semibold text-[#8C7667] hover:text-[#9E5D2D] transition w-fit"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Back to Projects</span>
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-[#362217]">
              {projectData?.name || "Project"} — Deployment Plan
            </h1>
            <span className="flex items-center gap-1 text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-[#2E6B4F]/10 text-[#2E6B4F] border border-[#2E6B4F]/20">
              <span className="h-1.5 w-1.5 rounded-full bg-[#2E6B4F] animate-ping" />
              {currentStatus}
            </span>
          </div>
          <p className="text-xs text-[#5E4C3E] flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-[#9E5D2D]" />
            <span>AI-generated preview before provisioning AWS infrastructure</span>
            <span>•</span>
            <span className="font-mono text-[#8C7667]">{projectData?.repoName}</span>
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            variant="outline"
            size="sm"
            icon={Cloud}
            onClick={() => navigate(`/project/${id}/infrastructure`)}
          >
            AWS Infrastructure
          </Button>

          <Button
            variant="outline"
            size="sm"
            icon={Container}
            onClick={() => navigate(`/project/${id}/docker`)}
          >
            Container Blueprint
          </Button>

          <Button
            variant="outline"
            size="sm"
            icon={RefreshCw}
            loading={regenerating}
            onClick={handleRegenerate}
          >
            Re-generate with AI
          </Button>

          <Button
            size="sm"
            icon={Rocket}
            onClick={() => navigate(`/project/${id}/deploy`)}
          >
            Proceed to Deploy
          </Button>
        </div>
      </div>

      {/* Step 10: Project State Machine Lifecycle Tracker */}
      <div className="p-4 rounded-2xl bg-white border border-[#EAE1D5] flex flex-col sm:flex-row items-center justify-between gap-3 shadow-xs">
        <div className="flex items-center gap-2 text-xs font-bold text-[#8C7667] uppercase tracking-wider">
          <Zap className="h-4 w-4 text-[#9E5D2D]" />
          <span>Deployment Lifecycle:</span>
        </div>
        <div className="flex items-center gap-2 sm:gap-4 overflow-x-auto w-full sm:w-auto">
          {lifecycleSteps.map((step, idx) => (
            <div key={idx} className="flex items-center gap-2 text-xs font-semibold">
              <span
                className={`flex items-center justify-center h-6 w-6 rounded-full text-[11px] font-bold ${
                  step.done
                    ? "bg-[#2E6B4F] text-white"
                    : "bg-[#FAF8F5] text-[#8C7667] border border-[#DCD0C3]"
                }`}
              >
                {step.done ? <Check className="h-3.5 w-3.5" /> : idx + 1}
              </span>
              <span className={step.done ? "text-[#362217]" : "text-[#8C7667]"}>
                {step.label}
              </span>
              {idx < lifecycleSteps.length - 1 && (
                <span className="text-[#DCD0C3] mx-1">→</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Step 8: Deployment Plan Cards Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {/* Framework */}
        <div className="p-3.5 rounded-2xl bg-white border border-[#EAE1D5] flex flex-col gap-1 shadow-xs">
          <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider flex items-center gap-1">
            <Boxes className="h-3 w-3 text-[#9E5D2D]" /> Framework
          </span>
          <span className="text-sm font-bold text-[#362217] truncate">{projectData?.framework || "React"}</span>
        </div>

        {/* AWS Target */}
        <div className="p-3.5 rounded-2xl bg-white border border-[#EAE1D5] flex flex-col gap-1 shadow-xs">
          <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider flex items-center gap-1">
            <Cloud className="h-3 w-3 text-[#3B7A75]" /> AWS Target
          </span>
          <span className="text-sm font-bold text-[#362217] truncate">{plan?.deploymentTarget || "ECS Fargate"}</span>
        </div>

        {/* CPU */}
        <div className="p-3.5 rounded-2xl bg-white border border-[#EAE1D5] flex flex-col gap-1 shadow-xs">
          <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider flex items-center gap-1">
            <Cpu className="h-3 w-3 text-[#9E5D2D]" /> CPU
          </span>
          <span className="text-sm font-bold text-[#9E5D2D] font-mono">{plan?.cpu || "0.5 vCPU"}</span>
        </div>

        {/* Memory */}
        <div className="p-3.5 rounded-2xl bg-white border border-[#EAE1D5] flex flex-col gap-1 shadow-xs">
          <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider flex items-center gap-1">
            <Server className="h-3 w-3 text-[#9E5D2D]" /> Memory
          </span>
          <span className="text-sm font-bold text-[#362217] font-mono">{plan?.memory || "1 GB"}</span>
        </div>

        {/* Health Check */}
        <div className="p-3.5 rounded-2xl bg-white border border-[#EAE1D5] flex flex-col gap-1 shadow-xs">
          <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3 text-[#2E6B4F]" /> Health Check
          </span>
          <span className="text-sm font-bold text-[#2E6B4F] font-mono">{plan?.healthCheck || "/"}</span>
        </div>

        {/* Dockerfile */}
        <div className="p-3.5 rounded-2xl bg-white border border-[#EAE1D5] flex flex-col gap-1 shadow-xs">
          <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider flex items-center gap-1">
            <Terminal className="h-3 w-3 text-[#9E5D2D]" /> Dockerfile
          </span>
          <span className="text-xs font-bold text-[#362217] truncate">
            {plan?.dockerStrategy === "EXISTING" ? "Existing Spec" : "Will be generated"}
          </span>
        </div>

        {/* Terraform */}
        <div className="p-3.5 rounded-2xl bg-white border border-[#EAE1D5] flex flex-col gap-1 shadow-xs">
          <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider flex items-center gap-1">
            <FileCode className="h-3 w-3 text-[#9E5D2D]" /> Terraform
          </span>
          <span className="text-xs font-bold text-[#362217] truncate">ECS Fargate Template</span>
        </div>
      </div>

      {/* AI Recommendation Banner */}
      <div className="p-5 rounded-3xl bg-gradient-to-r from-[#FAF6F0] via-[#F5EFE6] to-[#FAF6F0] border border-[#E8DCCF] flex items-start gap-4 shadow-sm">
        <div className="p-3 rounded-2xl bg-white text-[#9E5D2D] shadow-sm border border-[#E8DCCF] shrink-0">
          <Sparkles className="h-6 w-6" />
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-[#8C7667] uppercase tracking-wider">
              AI Recommendation ({plan?.source || "Gemini 2.5 Flash"})
            </span>
            <span className="text-[10px] text-[#2E6B4F] font-semibold bg-[#2E6B4F]/10 px-2 py-0.5 rounded-md border border-[#2E6B4F]/20">
              Verified Architecture
            </span>
          </div>
          <p className="text-sm font-medium text-[#362217] leading-relaxed">
            {plan?.explanation ||
              `Use ECS Fargate with ${plan?.cpu || "0.5 vCPU"} and ${plan?.memory || "1 GB"} RAM. Generate a multi-stage Dockerfile and enable ${plan?.healthCheck || "/"} as the health check endpoint.`}
          </p>
          <p className="text-[11px] text-[#8C7667] mt-1 italic">
            * Note: Nothing is deployed yet. Review the environment variables and blueprint files below before triggering AWS provisioning.
          </p>
        </div>
      </div>

      <DatabaseCard
        projectId={id}
        needed={(projectData.envAnalysis?.services || []).some((service) => /postgres|mysql|maria|database|sql/i.test(`${service.id} ${service.label}`)) || (projectData.requiredEnv || []).some((name) => /DATABASE_URL|^DB_|POSTGRES|MYSQL/.test(name))}
        onChange={(mode, engine) => setDatabaseMode({ mode, engine })}
        onNotify={showToast}
      />

      {/* Step 9: Environment variables detected from the source */}
      <EnvironmentWizard
        providedKeys={databaseMode.mode === "rds" ? MANAGED_DB_KEYS[databaseMode.engine] || MANAGED_DB_KEYS.postgres : []}
        key={projectData.envAnalysis?.scannedAt || "unscanned"}
        project={projectData}
        envValues={envValues}
        setEnvValues={setEnvValues}
        onSave={handleSaveEnvVars}
        saving={savingEnv}
        onScan={handleScanEnv}
        scanning={scanningEnv}
      />

      {/* Blueprint Inspector Tabs (Dockerfile & Terraform) */}
      <Card glow={false} className="flex flex-col gap-4 bg-white border border-[#EAE1D5]">
        <div className="flex items-center justify-between border-b border-[#EADFCF] pb-3">
          <div className="flex items-center gap-2">
            <FileCode className="h-5 w-5 text-[#9E5D2D]" />
            <h3 className="text-base font-bold text-[#362217]">Infrastructure Blueprint Code</h3>
          </div>

          <div className="flex items-center gap-2">
            <div role="tablist" aria-label="Infrastructure blueprint type" className="flex items-center rounded-xl bg-[#FAF8F5] p-1 border border-[#EAE1D5]">
              <button
                role="tab"
                aria-selected={activeTab === "docker"}
                onClick={() => setActiveTab("docker")}
                className={`px-3 py-1 text-xs font-semibold rounded-lg transition ${
                  activeTab === "docker"
                    ? "bg-white text-[#9E5D2D] shadow-xs"
                    : "text-[#8C7667] hover:text-[#362217]"
                }`}
              >
                Dockerfile
              </button>
              <button
                role="tab"
                aria-selected={activeTab === "terraform"}
                onClick={() => setActiveTab("terraform")}
                className={`px-3 py-1 text-xs font-semibold rounded-lg transition ${
                  activeTab === "terraform"
                    ? "bg-white text-[#9E5D2D] shadow-xs"
                    : "text-[#8C7667] hover:text-[#362217]"
                }`}
              >
                Terraform (main.tf)
              </button>
            </div>

            <Button
              variant="outline"
              size="sm"
              icon={copiedCode ? Check : Copy}
              onClick={() =>
                handleCopyCode(
                  activeTab === "docker"
                    ? blueprints?.dockerfile || ""
                    : blueprints?.terraform?.mainTf || ""
                )
              }
            >
              {copiedCode ? "Copied" : "Copy Blueprint"}
            </Button>
          </div>
        </div>

        <div className="rounded-2xl bg-[#2C1A10] text-[#F3E5D8] font-mono text-xs overflow-x-auto p-5 max-h-96 leading-relaxed scrollbar-thin">
          <pre>
            {activeTab === "docker"
              ? blueprints?.dockerfile || "# Dockerfile Blueprint"
              : blueprints?.terraform?.mainTf || "# Terraform ECS Fargate Blueprint"}
          </pre>
        </div>
      </Card>
    </div>
  );
}
