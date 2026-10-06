import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  Container,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Copy,
  Check,
  Download,
  RefreshCw,
  FileCode,
  ShieldCheck,
  Layers,
  ArrowRight,
  Sparkles,
  HardDrive,
  FileCheck,
} from "lucide-react";
import Card from "../components/Card";
import Button from "../components/Button";
import {
  getProjectDockerConfig,
  updateProjectDockerStrategy,
  saveProjectDockerFiles,
  validateDockerContent,
} from "../services/api";

export default function DockerPreview() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [switchingStrategy, setSwitchingStrategy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copiedTab, setCopiedTab] = useState(null);
  const [activeTab, setActiveTab] = useState("dockerfile");
  const [notification, setNotification] = useState(null);
  const [dirty, setDirty] = useState(false);

  const [config, setConfig] = useState(null);
  const [dockerfile, setDockerfile] = useState("");
  const [dockerignore, setDockerignore] = useState("");
  const [strategy, setStrategy] = useState("GENERATE");
  const [loadError, setLoadError] = useState(null);
  const loadGeneration = useRef(0);
  const notificationTimer = useRef(null);

  const showNotification = (type, message) => {
    window.clearTimeout(notificationTimer.current);
    setNotification({ type, message });
    notificationTimer.current = window.setTimeout(() => setNotification(null), 4000);
  };

  const fetchDockerConfig = async () => {
    const generation = ++loadGeneration.current;
    try {
      setLoading(true);
      setLoadError(null);
      setConfig(null);
      const data = await getProjectDockerConfig(id);
      if (generation !== loadGeneration.current) return;
      setConfig(data);
      setDockerfile(data.dockerfile || "");
      setDockerignore(data.dockerignore || "");
      setStrategy(data.strategy || "GENERATE");
      setDirty(false);
    } catch (err) {
      if (generation !== loadGeneration.current) return;
      console.error("Failed to load Docker configuration:", err);
      setLoadError(err.response?.data?.message || "Failed to load the container blueprint.");
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  };

  useEffect(() => {
    const task = window.setTimeout(() => {
      void fetchDockerConfig();
    }, 0);
    return () => {
      window.clearTimeout(task);
      loadGeneration.current += 1;
      window.clearTimeout(notificationTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleStrategyChange = async (newStrategy) => {
    if (newStrategy === strategy || switchingStrategy) return;
    try {
      setSwitchingStrategy(true);
      const data = await updateProjectDockerStrategy(id, newStrategy);
      setConfig(data);
      setDockerfile(data.dockerfile || "");
      setDockerignore(data.dockerignore || "");
      setStrategy(newStrategy);
      setDirty(false);
      showNotification(
        "success",
        `Switched strategy to ${newStrategy === "EXISTING" ? "Repository Existing Dockerfile" : "SkyForge Optimized Multi-Stage Dockerfile"}`
      );
    } catch (err) {
      console.error("Failed to switch Docker strategy:", err);
      showNotification("error", "Failed to update strategy.");
    } finally {
      setSwitchingStrategy(false);
    }
  };

  const handleSaveToDisk = async () => {
    try {
      setSaving(true);
      const res = await saveProjectDockerFiles(id, dockerfile, dockerignore);
      showNotification("success", "Docker blueprints successfully verified and written to disk!");
      if (res.strategy) setStrategy(res.strategy);
      if (res.project) {
        setConfig((prev) => ({ ...prev, project: res.project, validation: res.validation }));
      setDirty(false);
      }
    } catch (err) {
      console.error("Failed to save Docker files:", err);
      showNotification("error", "Failed to save files to disk.");
    } finally {
      setSaving(false);
    }
  };

  const handleValidate = async () => {
    try {
      setSaving(true);
      const result = await validateDockerContent(id, dockerfile);
      setConfig((previous) => ({ ...previous, validation: result.validation }));
      showNotification(
        result.validation.isValid ? "success" : "error",
        result.validation.isValid ? "Dockerfile validation passed." : "Dockerfile validation found issues."
      );
    } catch (err) {
      showNotification("error", err.response?.data?.message || "Dockerfile validation failed.");
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async (content, tab) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedTab(tab);
      window.setTimeout(() => setCopiedTab(null), 2000);
    } catch {
      showNotification("error", "Clipboard access was denied.");
    }
  };

  const handleDownload = (filename, content) => {
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <RefreshCw className="h-8 w-8 text-[#9E5D2D] animate-spin" />
        <p className="text-sm font-semibold text-[#8C7667]">
          Synthesizing production container blueprints & running validation...
        </p>
      </div>
    );
  }

  if (loadError || !config) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center" role="alert">
        <AlertTriangle className="h-10 w-10 text-[#9E2A2B]" />
        <h2 className="text-lg font-bold text-[#362217]">Container blueprint unavailable</h2>
        <p className="max-w-md text-sm text-[#5E4C3E]">{loadError || "The server returned an incomplete container blueprint."}</p>
        <div className="flex gap-3">
          <Button variant="outline" onClick={() => navigate("/dashboard/projects")}>Back to Projects</Button>
          <Button onClick={fetchDockerConfig} icon={RefreshCw}>Retry</Button>
        </div>
      </div>
    );
  }

  const project = config.project || {};
  const validation = config?.validation || {};
  const checks = validation.checks || {};
  const hasExistingDocker = Boolean(config?.hasExistingDocker || project.dockerized);

  return (
    <div className="flex flex-col gap-8 max-w-6xl mx-auto pb-16">
      {/* Toast Notification */}
      {notification && (
        <div
          className={`fixed bottom-6 right-6 z-50 px-5 py-3 rounded-2xl shadow-lg border text-sm font-semibold flex items-center gap-3 transition-all ${
            notification.type === "success"
              ? "bg-[#2E6B4F] text-white border-[#24543D]"
              : "bg-[#9E2A2B] text-white border-[#7E2223]"
          }`}
        >
          {notification.type === "success" ? (
            <CheckCircle2 className="h-5 w-5" />
          ) : (
            <AlertTriangle className="h-5 w-5" />
          )}
          <span>{notification.message}</span>
        </div>
      )}

      {/* Header & Breadcrumb */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#EADFCF] pb-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-[#8C7667]">
            <Link to="/dashboard/projects" className="hover:text-[#362217] transition-colors">
              Projects
            </Link>
            <span>/</span>
            <span className="text-[#362217]">{project.name || "Project"}</span>
            <span>/</span>
            <span className="text-[#9E5D2D] font-bold">Container Blueprint</span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl md:text-3xl font-bold text-[#362217] flex items-center gap-2.5">
              <Container className="h-7 w-7 text-[#9E5D2D]" />
              Dockerfile Blueprint
            </h1>
            <span className="text-xs px-2.5 py-1 rounded-full bg-[#9E5D2D]/10 text-[#9E5D2D] font-bold border border-[#9E5D2D]/20">
              {project.framework || "Generic"}
            </span>
            {validation.isValid && !dirty && (
              <span className="text-xs px-2.5 py-1 rounded-full bg-[#2E6B4F]/10 text-[#2E6B4F] font-bold border border-[#2E6B4F]/20 flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Validated
              </span>
            )}
            <span className="text-xs px-2.5 py-1 rounded-full bg-[#F5EFE6] text-[#5E4C3E] font-semibold border border-[#EADFCF]">
              Editable blueprint
            </span>
            <span className="text-xs px-2.5 py-1 rounded-full bg-[#362217] text-[#FAF6F0] font-semibold">
              Status: {project.status || "Containerized"}
            </span>
          </div>

          <p className="text-sm text-[#5E4C3E]">
            Editable multi-stage container specification with layer caching guidance and server-side Dockerfile validation.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <Button
            variant="outline"
            onClick={fetchDockerConfig}
            className="flex items-center gap-2 border-[#EADFCF] bg-white text-[#5E4C3E] hover:bg-[#FAF6F0]"
          >
            <RefreshCw className="h-4 w-4" />
            Reload from server
          </Button>
          <Button
            variant="outline"
            onClick={handleValidate}
            disabled={saving}
            className="flex items-center gap-2 border-[#EADFCF] bg-white text-[#5E4C3E] hover:bg-[#FAF6F0]"
          >
            <ShieldCheck className="h-4 w-4" />
            {saving ? "Checking..." : "Validate"}
          </Button>
          <Button
            variant="outline"
            onClick={handleSaveToDisk}
            disabled={saving}
            className="flex items-center gap-2 border-[#EADFCF] bg-white text-[#5E4C3E] hover:bg-[#FAF6F0]"
          >
            <HardDrive className="h-4 w-4 text-[#9E5D2D]" />
            {saving ? "Writing..." : "Save to Disk"}
          </Button>
          <Button
            onClick={() => navigate(`/project/${id}/plan`)}
            className="flex items-center gap-2 bg-[#9E5D2D] hover:bg-[#844C22] text-white shadow-sm"
          >
            Review AI Plan
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Lifecycle Progress Bar */}
      <div className="p-4 rounded-2xl bg-white border border-[#EAE1D5] shadow-sm flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-[#9E5D2D]/10 text-[#9E5D2D]">
            <Layers className="h-5 w-5" />
          </div>
          <div>
            <span className="text-xs font-bold text-[#8C7667] uppercase tracking-wider">
              Deployment Lifecycle
            </span>
            <div className="flex items-center gap-2 text-sm font-bold text-[#362217]">
              <span>Stage 3 of 4:</span>
              <span className="text-[#9E5D2D]">Containerization & Blueprint Validation</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs font-semibold">
          <span className="text-[#2E6B4F] flex items-center gap-1">
            <CheckCircle2 className="h-4 w-4" /> 1. Imported
          </span>
          <span className="text-[#8C7667]">→</span>
          <span className="text-[#2E6B4F] flex items-center gap-1">
            <CheckCircle2 className="h-4 w-4" /> 2. Planned
          </span>
          <span className="text-[#8C7667]">→</span>
          <span className="px-2.5 py-1 rounded-lg bg-[#9E5D2D] text-white font-bold shadow-xs">
            3. Containerized
          </span>
          <span className="text-[#8C7667]">→</span>
          <span className="text-[#8C7667]">4. Ready to Deploy</span>
        </div>
      </div>

      {strategy === "CUSTOM" && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl bg-[#FAF6F0] border border-[#EADFCF]">
          <p className="text-xs text-[#5E4C3E]">
            Deployments build from your saved custom Dockerfile. Reverting regenerates the SkyForge template and discards your edits.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={switchingStrategy}
            onClick={() => handleStrategyChange("GENERATE")}
            className="shrink-0 border-[#EADFCF] bg-white text-[#5E4C3E] hover:bg-[#FAF6F0]"
          >
            Revert to SkyForge Template
          </Button>
        </div>
      )}

      {/* Step 7: Existing Dockerfile Detection & Strategy Switcher */}
      {hasExistingDocker && (
        <Card glow={false} className="bg-gradient-to-r from-[#FAF6F0] to-[#F3EBE1] border-2 border-[#9E5D2D]/30 flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-2xl bg-[#9E5D2D]/10 text-[#9E5D2D] mt-0.5">
                <Sparkles className="h-5 w-5" />
              </div>
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-[#362217]">Existing Dockerfile Detected</h3>
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-[#2E6B4F]/10 text-[#2E6B4F] border border-[#2E6B4F]/20">
                    Repo Dockerfile Found
                  </span>
                </div>
                <p className="text-xs text-[#5E4C3E] leading-relaxed">
                  SkyForge detected a pre-existing Dockerfile in your repository ({project.repoName}). You can choose to keep your repository's native file or generate SkyForge's production-optimized multi-stage blueprint.
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
            {/* Strategy Option 1: Use Existing */}
            <div
              role="button"
              tabIndex={0}
              aria-pressed={strategy === "EXISTING"}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void handleStrategyChange("EXISTING");
                }
              }}
              onClick={() => handleStrategyChange("EXISTING")}
              className={`p-4 rounded-2xl border-2 cursor-pointer transition-all flex flex-col justify-between gap-3 ${
                strategy === "EXISTING"
                  ? "bg-white border-[#9E5D2D] shadow-sm ring-2 ring-[#9E5D2D]/20"
                  : "bg-white/60 border-[#EADFCF] hover:border-[#8C7667]"
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="text-sm font-bold text-[#362217]">Use Existing Dockerfile</h4>
                  <p className="text-xs text-[#5E4C3E] mt-1">
                    Retain and deploy the container specification exactly as defined in your repository.
                  </p>
                </div>
                <div
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    strategy === "EXISTING"
                      ? "border-[#9E5D2D] bg-[#9E5D2D] text-white"
                      : "border-[#8C7667]"
                  }`}
                >
                  {strategy === "EXISTING" && <Check className="h-3 w-3 stroke-[3]" />}
                </div>
              </div>
              <span className="text-[11px] font-semibold text-[#8C7667]">
                Best for custom dependencies and custom entrypoints
              </span>
            </div>

            {/* Strategy Option 2: Generate Optimized */}
            <div
              role="button"
              tabIndex={0}
              aria-pressed={strategy === "GENERATE"}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void handleStrategyChange("GENERATE");
                }
              }}
              onClick={() => handleStrategyChange("GENERATE")}
              className={`p-4 rounded-2xl border-2 cursor-pointer transition-all flex flex-col justify-between gap-3 ${
                strategy === "GENERATE"
                  ? "bg-white border-[#9E5D2D] shadow-sm ring-2 ring-[#9E5D2D]/20"
                  : "bg-white/60 border-[#EADFCF] hover:border-[#8C7667]"
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-bold text-[#362217]">Generate Optimized</h4>
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#9E5D2D]/10 text-[#9E5D2D]">
                      Recommended
                    </span>
                  </div>
                  <p className="text-xs text-[#5E4C3E] mt-1">
                    Multi-stage build with Alpine Linux, frozen lockfile caching, and minimal attack surface.
                  </p>
                </div>
                <div
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    strategy === "GENERATE"
                      ? "border-[#9E5D2D] bg-[#9E5D2D] text-white"
                      : "border-[#8C7667]"
                  }`}
                >
                  {strategy === "GENERATE" && <Check className="h-3 w-3 stroke-[3]" />}
                </div>
              </div>
              <span className="text-[11px] font-semibold text-[#2E6B4F]">
                50-80% smaller image size, faster deployments, zero secrets leak
              </span>
            </div>
          </div>
        </Card>
      )}

      {/* Step 8: Docker Validation Diagnostics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Check 1: FROM */}
        <div className="p-4 rounded-2xl bg-white border border-[#EAE1D5] shadow-xs flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`p-2 rounded-xl ${
                checks.hasFrom ? "bg-[#2E6B4F]/10 text-[#2E6B4F]" : "bg-[#9E2A2B]/10 text-[#9E2A2B]"
              }`}
            >
              {checks.hasFrom ? <CheckCircle2 className="h-5 w-5" /> : <XCircle className="h-5 w-5" />}
            </div>
            <div>
              <span className="text-xs font-bold text-[#8C7667] uppercase">Base Image</span>
              <p className="text-sm font-bold text-[#362217]">FROM Instruction</p>
            </div>
          </div>
          <span
            className={`text-xs font-bold px-2 py-0.5 rounded-md ${
              checks.hasFrom ? "bg-[#2E6B4F]/10 text-[#2E6B4F]" : "bg-[#9E2A2B]/10 text-[#9E2A2B]"
            }`}
          >
            {checks.hasFrom ? "Valid" : "Missing"}
          </span>
        </div>

        {/* Check 2: WORKDIR */}
        <div className="p-4 rounded-2xl bg-white border border-[#EAE1D5] shadow-xs flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`p-2 rounded-xl ${
                checks.hasWorkdir ? "bg-[#2E6B4F]/10 text-[#2E6B4F]" : "bg-[#B45309]/10 text-[#B45309]"
              }`}
            >
              {checks.hasWorkdir ? <CheckCircle2 className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
            </div>
            <div>
              <span className="text-xs font-bold text-[#8C7667] uppercase">Directory</span>
              <p className="text-sm font-bold text-[#362217]">WORKDIR Instruction</p>
            </div>
          </div>
          <span
            className={`text-xs font-bold px-2 py-0.5 rounded-md ${
              checks.hasWorkdir ? "bg-[#2E6B4F]/10 text-[#2E6B4F]" : "bg-[#B45309]/10 text-[#B45309]"
            }`}
          >
            {checks.hasWorkdir ? "Organized" : "Default"}
          </span>
        </div>

        {/* Check 3: CMD */}
        <div className="p-4 rounded-2xl bg-white border border-[#EAE1D5] shadow-xs flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`p-2 rounded-xl ${
                checks.hasCmd ? "bg-[#2E6B4F]/10 text-[#2E6B4F]" : "bg-[#9E2A2B]/10 text-[#9E2A2B]"
              }`}
            >
              {checks.hasCmd ? <CheckCircle2 className="h-5 w-5" /> : <XCircle className="h-5 w-5" />}
            </div>
            <div>
              <span className="text-xs font-bold text-[#8C7667] uppercase">Execution</span>
              <p className="text-sm font-bold text-[#362217]">CMD / Entrypoint</p>
            </div>
          </div>
          <span
            className={`text-xs font-bold px-2 py-0.5 rounded-md ${
              checks.hasCmd ? "bg-[#2E6B4F]/10 text-[#2E6B4F]" : "bg-[#9E2A2B]/10 text-[#9E2A2B]"
            }`}
          >
            {checks.hasCmd ? "Runnable" : "Missing"}
          </span>
        </div>

        {/* Check 4: EXPOSE */}
        <div className="p-4 rounded-2xl bg-white border border-[#EAE1D5] shadow-xs flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`p-2 rounded-xl ${
                checks.hasExpose ? "bg-[#2E6B4F]/10 text-[#2E6B4F]" : "bg-[#B45309]/10 text-[#B45309]"
              }`}
            >
              {checks.hasExpose ? <CheckCircle2 className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
            </div>
            <div>
              <span className="text-xs font-bold text-[#8C7667] uppercase">Networking</span>
              <p className="text-sm font-bold text-[#362217]">EXPOSE Port</p>
            </div>
          </div>
          <span
            className={`text-xs font-bold px-2 py-0.5 rounded-md ${
              checks.hasExpose ? "bg-[#2E6B4F]/10 text-[#2E6B4F]" : "bg-[#B45309]/10 text-[#B45309]"
            }`}
          >
            {checks.hasExpose ? `Port ${validation.details?.exposedPorts?.[0] || project.port || 80}` : "Default"}
          </span>
        </div>
      </div>

      {/* Step 9: Disk Storage Persistence Banner */}
      <div className="p-4 rounded-2xl bg-[#FAF6F0] border border-[#EADFCF] flex flex-col md:flex-row items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2.5">
          <HardDrive className="h-4 w-4 text-[#9E5D2D]" />
          <span className="font-semibold text-[#5E4C3E]">Local File Persistence:</span>
          <code className="bg-white px-2 py-0.5 rounded-md border border-[#EADFCF] text-[#362217] font-mono">
            {config?.dockerPath || `generated/${id}/Dockerfile`}
          </code>
          <code className="bg-white px-2 py-0.5 rounded-md border border-[#EADFCF] text-[#362217] font-mono">
            {config?.dockerignorePath || `generated/${id}/.dockerignore`}
          </code>
        </div>
        <div className="flex items-center gap-2 text-[#2E6B4F] font-semibold">
          <FileCheck className="h-4 w-4" />
          <span>Files synchronized to disk</span>
        </div>
      </div>

      {/* Step 10: Tabbed Blueprint Inspector */}
      <Card glow={false} className="flex flex-col gap-0 p-0 overflow-hidden bg-white border border-[#EAE1D5]">
        {/* Tab Header */}
        <div className="flex items-center justify-between bg-[#F5EFE6] border-b border-[#EADFCF] px-4 py-3">
          <div role="tablist" aria-label="Docker blueprint file" className="flex items-center gap-2">
            <button
              role="tab"
              aria-selected={activeTab === "dockerfile"}
              onClick={() => setActiveTab("dockerfile")}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${
                activeTab === "dockerfile"
                  ? "bg-white text-[#9E5D2D] shadow-xs"
                  : "text-[#5E4C3E] hover:text-[#362217] hover:bg-white/50"
              }`}
            >
              <FileCode className="h-4 w-4" />
              Dockerfile
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-[#2E6B4F]/10 text-[#2E6B4F]">
                Multi-Stage
              </span>
            </button>
            <button
              role="tab"
              aria-selected={activeTab === "dockerignore"}
              onClick={() => setActiveTab("dockerignore")}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${
                activeTab === "dockerignore"
                  ? "bg-white text-[#9E5D2D] shadow-xs"
                  : "text-[#5E4C3E] hover:text-[#362217] hover:bg-white/50"
              }`}
            >
              <FileCode className="h-4 w-4" />
              .dockerignore
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-[#9E5D2D]/10 text-[#9E5D2D]">
                Secrets Guard
              </span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                handleCopy(
                  activeTab === "dockerfile" ? dockerfile : dockerignore,
                  activeTab
                )
              }
              className="text-xs flex items-center gap-1.5 bg-white border-[#EADFCF] text-[#5E4C3E] hover:bg-[#FAF6F0]"
            >
              {copiedTab === activeTab ? (
                <>
                  <Check className="h-3.5 w-3.5 text-[#2E6B4F]" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                handleDownload(
                  activeTab === "dockerfile" ? "Dockerfile" : ".dockerignore",
                  activeTab === "dockerfile" ? dockerfile : dockerignore
                )
              }
              className="text-xs flex items-center gap-1.5 bg-white border-[#EADFCF] text-[#5E4C3E] hover:bg-[#FAF6F0]"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </Button>
          </div>
        </div>

        {!validation.isValid && (
          <div className="border-t border-[#F3B4B4] bg-[#FFF4F4] px-5 py-3 text-xs text-[#9E2A2B]" role="alert">
            {(validation.errors || []).map((error) => <p key={error}>• {error}</p>)}
          </div>
        )}

        {/* Code Content */}
        <div className="bg-[#1E1E1E] text-[#D4D4D4] p-5 font-mono text-xs leading-relaxed">
          <label htmlFor="docker-blueprint-editor" className="sr-only">Editable Docker blueprint</label>
          <textarea
            id="docker-blueprint-editor"
            value={activeTab === "dockerfile" ? dockerfile : dockerignore}
            onChange={(event) => {
              if (activeTab === "dockerfile") setDockerfile(event.target.value);
              else setDockerignore(event.target.value);
              setDirty(true);
            }}
            spellCheck={false}
            className="min-h-[420px] max-h-[600px] w-full resize-y rounded-lg border border-white/10 bg-[#1E1E1E] p-3 font-mono text-xs leading-relaxed text-[#D4D4D4] outline-none focus:border-[#C7834F]"
          />
        </div>

        {/* Footer info */}
        <div className="bg-[#FAF6F0] border-t border-[#EADFCF] px-5 py-3 flex items-center justify-between text-xs text-[#8C7667]">
          <span>
            {activeTab === "dockerfile"
              ? `Generated for ${project.framework || "Generic"} with port ${project.port || 80}`
              : "Prevents node_modules, .env secrets, and git files from entering the Docker build context"}
          </span>
          <span className={`font-semibold flex items-center gap-1 ${validation.isValid ? "text-[#2E6B4F]" : "text-[#9E2A2B]"}`}>
            <ShieldCheck className="h-4 w-4" /> {validation.isValid ? "Ready for container build" : "Validation fixes required"}
          </span>
        </div>
      </Card>

      {/* Next Step Action Box */}
      <div className="p-6 rounded-3xl bg-white border border-[#EAE1D5] shadow-sm flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-bold text-[#362217]">Ready to configure cloud deployment?</h3>
          <p className="text-xs text-[#5E4C3E]">
            Review the AI-generated ECS Fargate Terraform architecture, customize environment secrets, and verify cloud health checks.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <Button
            variant="outline"
            onClick={() => navigate("/dashboard/projects")}
            className="border-[#EADFCF] bg-white text-[#5E4C3E]"
          >
            Back to Projects
          </Button>
          <Button
            onClick={() => navigate(`/project/${id}/plan`)}
            className="bg-[#9E5D2D] hover:bg-[#844C22] text-white flex items-center gap-2 shadow-sm"
          >
            Proceed to Deployment Plan
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
