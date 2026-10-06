import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  Cloud,
  Layers,
  FileCode,
  DollarSign,
  CheckCircle2,
  AlertTriangle,
  Copy,
  Check,
  Download,
  RefreshCw,
  ArrowRight,
  HardDrive,
  Zap,
  CheckCheck,
  Rocket,
} from "lucide-react";
import Card from "../components/Card";
import Button from "../components/Button";
import TargetChooser from "../components/TargetChooser";
import BuildLocationCard from "../components/BuildLocationCard";
import {
  getProjectInfrastructure,
  updateProjectInfrastructureTarget,
} from "../services/api";

export default function InfrastructurePreview() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [activeTab, setActiveTab] = useState("main.tf");
  const [copied, setCopied] = useState(false);
  const [notification, setNotification] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [switchingTarget, setSwitchingTarget] = useState(false);
  const loadGeneration = useRef(0);
  const notificationTimer = useRef(null);

  const showNotification = (type, message) => {
    window.clearTimeout(notificationTimer.current);
    setNotification({ type, message });
    notificationTimer.current = window.setTimeout(() => setNotification(null), 4000);
  };

  const handleChooseTarget = async (target) => {
    if (target === data?.target || switchingTarget) return;
    try {
      setSwitchingTarget(true);
      const res = await updateProjectInfrastructureTarget(id, target);
      setData(res);
      if (res.files && Object.keys(res.files).length > 0) setActiveTab(Object.keys(res.files)[0]);
      showNotification("success", res.message || "Deployment target updated.");
    } catch (err) {
      showNotification("error", err.response?.data?.message || "Failed to change the deployment target.");
    } finally {
      setSwitchingTarget(false);
    }
  };

  const fetchInfrastructure = async () => {
    const generation = ++loadGeneration.current;
    try {
      setLoading(true);
      setLoadError(null);
      setData(null);
      const res = await getProjectInfrastructure(id);
      if (generation !== loadGeneration.current) return;
      setData(res);
      if (res.files && Object.keys(res.files).length > 0) {
        setActiveTab(Object.keys(res.files)[0]);
      }
    } catch (err) {
      if (generation !== loadGeneration.current) return;
      console.error("Failed to fetch infrastructure blueprint:", err);
      setLoadError(err.response?.data?.message || "Failed to load the cloud infrastructure blueprint.");
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  };

  useEffect(() => {
    const task = window.setTimeout(() => {
      void fetchInfrastructure();
    }, 0);
    return () => {
      window.clearTimeout(task);
      loadGeneration.current += 1;
      window.clearTimeout(notificationTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleCopyCode = async () => {
    const code = getActiveFileContent();
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      showNotification("error", "Clipboard access was denied.");
    }
  };

  const handleDownloadFile = () => {
    const code = getActiveFileContent();
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = activeTab;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const getActiveFileContent = () => {
    if (!data) return "";
    if (activeTab === "infrastructure.json") {
      return JSON.stringify(data.manifest, null, 2);
    }
    return data.files?.[activeTab] || "";
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <RefreshCw className="h-8 w-8 text-[#9E5D2D] animate-spin" />
        <p className="text-sm font-semibold text-[#8C7667]">
          Synthesizing modular Terraform architecture & estimating AWS costs...
        </p>
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center" role="alert">
        <AlertTriangle className="h-10 w-10 text-[#9E2A2B]" />
        <h2 className="text-lg font-bold text-[#362217]">Infrastructure preview unavailable</h2>
        <p className="max-w-md text-sm text-[#5E4C3E]">{loadError || "The server returned an incomplete infrastructure plan."}</p>
        <div className="flex gap-3">
          <Button variant="outline" onClick={() => navigate("/dashboard/projects")}>Back to Projects</Button>
          <Button onClick={fetchInfrastructure} icon={RefreshCw}>Retry</Button>
        </div>
      </div>
    );
  }

  const project = data.project || {};
  const cost = data?.costEstimation || {};
  const services = data?.services || [];
  const filesList = data?.files ? Object.keys(data.files) : [];
  const allTabs = [...filesList, "infrastructure.json"];

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
            <span className="text-[#9E5D2D] font-bold">AWS Infrastructure</span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl md:text-3xl font-bold text-[#362217] flex items-center gap-2.5">
              <Cloud className="h-7 w-7 text-[#9E5D2D]" />
              AWS Infrastructure Plan
            </h1>
            <span className="text-xs px-2.5 py-1 rounded-full bg-[#9E5D2D]/10 text-[#9E5D2D] font-bold border border-[#9E5D2D]/20">
              {data.displayName || "ECS Fargate"}
            </span>
            <span className="text-xs px-2.5 py-1 rounded-full bg-[#2E6B4F]/10 text-[#2E6B4F] font-bold border border-[#2E6B4F]/20 flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Ready to Generate
            </span>
            <span className="text-xs px-2.5 py-1 rounded-full bg-[#362217] text-[#FAF6F0] font-semibold">
              Cost: {cost.total || "$27/month"}
            </span>
          </div>

          <p className="text-sm text-[#5E4C3E]">
            {data.strategyDescription ||
              "Automated production-ready Terraform Infrastructure as Code (IaC) tailored to your application architecture."}
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <Button
            variant="outline"
            onClick={fetchInfrastructure}
            className="flex items-center gap-2 border-[#EADFCF] bg-white text-[#5E4C3E] hover:bg-[#FAF6F0]"
          >
            <RefreshCw className="h-4 w-4" />
            Re-plan
          </Button>
          <Button
            variant="outline"
            onClick={() => navigate(`/project/${id}/docker`)}
            className="flex items-center gap-2 border-[#EADFCF] bg-white text-[#5E4C3E] hover:bg-[#FAF6F0]"
          >
            View Dockerfile
          </Button>
          <Button
            disabled={!data.target}
            title={data.target ? undefined : "Choose a deployment target first"}
            onClick={() => navigate(`/project/${id}/deploy`)}
            className="flex items-center gap-2 bg-[#9E5D2D] hover:bg-[#844C22] text-white shadow-sm"
          >
            Deploy to AWS
            <Rocket className="h-4 w-4" />
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
              <span>Stage 4 of 4:</span>
              <span className="text-[#9E5D2D]">Cloud Infrastructure & Cost Blueprint</span>
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
          <span className="text-[#2E6B4F] flex items-center gap-1">
            <CheckCircle2 className="h-4 w-4" /> 3. Containerized
          </span>
          <span className="text-[#8C7667]">→</span>
          <span className="px-2.5 py-1 rounded-lg bg-[#9E5D2D] text-white font-bold shadow-xs">
            4. Architected
          </span>
        </div>
      </div>

      {/* Deployment Target (nothing preselected) */}
      <TargetChooser choices={data.choices || []} selected={data.target} onChoose={handleChooseTarget} busy={switchingTarget} />

      <BuildLocationCard projectId={id} initialMode={project.buildMode} onNotify={(message, type) => showNotification(type, message)} />

      {data.target && (
      <>
      {/* Visual Architecture Topology Diagram */}
      <Card glow={false} className="bg-white border border-[#EAE1D5] flex flex-col gap-4">
        <div className="flex items-center justify-between border-b border-[#EADFCF] pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-[#9E5D2D]/10 text-[#9E5D2D]">
              <Zap className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-base font-bold text-[#362217]">Visual Architecture Flow</h3>
              <p className="text-xs text-[#5E4C3E]">
                High-level cloud network topology and resource interactions created by SkyForge Terraform.
              </p>
            </div>
          </div>
          <span className="text-xs px-2.5 py-1 rounded-full bg-[#FAF8F5] border border-[#EAE1D5] text-[#8C7667] font-semibold">
            AWS Region: {data.region || "Not configured"}
          </span>
        </div>

        {/* Visual Topology Pipeline (from the server's architecture graph for the chosen target) */}
        <div className="p-6 rounded-2xl bg-[#FAF8F5] border border-[#EADFCF] flex flex-col md:flex-row items-center gap-3 overflow-x-auto">
          {(data.architectureGraph?.nodes || []).map((node, index, nodes) => {
            const link = (data.architectureGraph?.connections || []).find((connection) => connection.from === node.id && connection.to === nodes[index + 1]?.id);
            return (
              <div key={node.id} className="flex flex-col md:flex-row items-center gap-3 shrink-0">
                <div className="flex flex-col items-center gap-1.5 p-3 rounded-2xl bg-white border border-[#EAE1D5] shadow-xs w-36 text-center">
                  <span className="text-xs font-bold text-[#362217]">{node.label}</span>
                  <span className="text-[10px] text-[#8C7667] capitalize">{node.type}</span>
                </div>
                {index < nodes.length - 1 && (
                  <div className="flex flex-col items-center text-[#9E5D2D] font-bold text-[10px] w-20 text-center">
                    <ArrowRight className="h-4 w-4 rotate-90 md:rotate-0" />
                    <span>{link?.label || ""}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {/* AWS Services Grid */}
      <div className="flex flex-col gap-3">
        <h3 className="text-base font-bold text-[#362217]">Synthesized AWS Services ({services.length})</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {services.map((svc) => (
            <div key={svc.id} className="p-4 rounded-2xl bg-white border border-[#EAE1D5] shadow-xs flex flex-col justify-between gap-3">
              <div className="flex items-start justify-between">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[#9E5D2D]">
                    {svc.category}
                  </span>
                  <h4 className="text-sm font-bold text-[#362217] mt-0.5">{svc.name}</h4>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded-md font-bold bg-[#2E6B4F]/10 text-[#2E6B4F] border border-[#2E6B4F]/20">
                  {svc.status}
                </span>
              </div>
              <p className="text-xs text-[#5E4C3E] leading-relaxed">{svc.description}</p>
              <div className="text-[11px] font-mono text-[#8C7667] pt-2 border-t border-[#F0E7DC]">
                {svc.specs}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Step 8: Cost Estimator Card */}
      <Card glow={false} className="bg-white border border-[#EAE1D5] flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#EADFCF] pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-[#2E6B4F]/10 text-[#2E6B4F]">
              <DollarSign className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-[#362217]">AWS Monthly Cost Estimator</h3>
              <p className="text-xs text-[#5E4C3E]">
                Transparent itemized forecast based on AWS public US-East pricing without hidden fees.
              </p>
            </div>
          </div>

          <div className="flex items-baseline gap-2">
            <span className="text-xs text-[#8C7667] font-semibold">Total Estimated Cost:</span>
            <span className="text-xl font-bold text-[#2E6B4F] font-mono">{cost.total || "$27/month"}</span>
          </div>
        </div>

        {/* Cost Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[#EADFCF] text-[#8C7667] font-bold">
                <th className="pb-2.5">Resource / Component</th>
                <th className="pb-2.5">Category</th>
                <th className="pb-2.5">Unit Pricing Rate</th>
                <th className="pb-2.5">Notes</th>
                <th className="pb-2.5 text-right">Est. Monthly</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F0E7DC]">
              {cost.breakdown?.map((item, idx) => (
                <tr key={idx} className="hover:bg-[#FAF8F5]/60 transition">
                  <td className="py-2.5 font-bold text-[#362217]">{item.resource}</td>
                  <td className="py-2.5">
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-[#9E5D2D]/10 text-[#9E5D2D]">
                      {item.category}
                    </span>
                  </td>
                  <td className="py-2.5 font-mono text-[#5E4C3E]">{item.rate}</td>
                  <td className="py-2.5 text-[#8C7667]">{item.notes}</td>
                  <td className="py-2.5 text-right font-mono font-bold text-[#362217]">
                    {item.formattedMonthly}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Disk Storage Sync Banner */}
      <div className="p-4 rounded-2xl bg-[#FAF6F0] border border-[#EADFCF] flex flex-col md:flex-row items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2.5">
          <HardDrive className="h-4 w-4 text-[#9E5D2D]" />
          <span className="font-semibold text-[#5E4C3E]">Local IaC Files Synced:</span>
          <code className="bg-white px-2 py-0.5 rounded-md border border-[#EADFCF] text-[#362217] font-mono">
            {data.terraformPath || `generated/${id}/terraform`}
          </code>
          <code className="bg-white px-2 py-0.5 rounded-md border border-[#EADFCF] text-[#362217] font-mono">
            {data.manifestPath || `generated/${id}/infrastructure.json`}
          </code>
        </div>
        <div className="flex items-center gap-2 text-[#2E6B4F] font-semibold">
          <CheckCheck className="h-4 w-4" />
          <span>Terraform preview files written (not validated)</span>
        </div>
      </div>

      {/* Tabbed Terraform Code Inspector */}
      <Card glow={false} className="flex flex-col gap-0 p-0 overflow-hidden bg-white border border-[#EAE1D5]">
        {/* Tab Header */}
        <div className="flex flex-wrap items-center justify-between bg-[#F5EFE6] border-b border-[#EADFCF] px-4 py-3 gap-2">
          <div role="tablist" aria-label="Terraform preview file" className="flex flex-wrap items-center gap-1.5 overflow-x-auto">
            {allTabs.map((tab) => (
              <button
                key={tab}
                role="tab"
                aria-selected={activeTab === tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${
                  activeTab === tab
                    ? "bg-white text-[#9E5D2D] shadow-xs"
                    : "text-[#5E4C3E] hover:text-[#362217] hover:bg-white/50"
                }`}
              >
                <FileCode className="h-3.5 w-3.5" />
                {tab}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyCode}
              className="text-xs flex items-center gap-1.5 bg-white border-[#EADFCF] text-[#5E4C3E] hover:bg-[#FAF6F0]"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-[#2E6B4F]" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  Copy Code
                </>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownloadFile}
              className="text-xs flex items-center gap-1.5 bg-white border-[#EADFCF] text-[#5E4C3E] hover:bg-[#FAF6F0]"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </Button>
          </div>
        </div>

        {/* Code View */}
        <div className="bg-[#1E1E1E] text-[#D4D4D4] p-5 font-mono text-xs overflow-x-auto leading-relaxed max-h-[500px]">
          <pre className="whitespace-pre">{getActiveFileContent()}</pre>
        </div>

        {/* Code Footer */}
        <div className="bg-[#FAF6F0] border-t border-[#EADFCF] px-5 py-3 flex items-center justify-between text-xs text-[#8C7667]">
          <span>
            File: <code className="font-mono text-[#362217] font-bold">{activeTab}</code>
          </span>
          <span className="font-semibold text-[#2E6B4F] flex items-center gap-1">
            <CheckCircle2 className="h-4 w-4" /> Preview only — review before terraform init & apply
          </span>
        </div>
      </Card>

      {/* Next Step / Action Box */}
      <div className="p-6 rounded-3xl bg-white border border-[#EAE1D5] shadow-sm flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-bold text-[#362217]">Ready to deploy this cloud blueprint?</h3>
          <p className="text-xs text-[#5E4C3E]">
            Review environment variables or trigger real-time AWS provisioning via the connected cloud credentials in Sprint 8.
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
            variant="outline"
            onClick={() => navigate(`/project/${id}/plan`)}
            className="border-[#EADFCF] bg-white text-[#5E4C3E]"
          >
            Configure Environment
          </Button>
          <Button
            onClick={() => navigate(`/project/${id}/deploy`)}
            className="bg-[#9E5D2D] hover:bg-[#844C22] text-white flex items-center gap-2 shadow-sm"
          >
            Proceed to Live Deploy
            <Rocket className="h-4 w-4" />
          </Button>
        </div>
      </div>
      </>
      )}
    </div>
  );
}
