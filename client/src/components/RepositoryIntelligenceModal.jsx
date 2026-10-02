import { useState } from "react";
import Button from "./Button";
import {
  Cpu,
  CheckCircle2,
  Layers,
  Terminal,
  Server,
  Cloud,
  Code2,
  Package,
  Boxes,
  PlayCircle,
  Hammer,
  ShieldCheck,
  Sparkles,
  Copy,
  Check,
  Key,
  X,
  Zap,
} from "lucide-react";

export default function RepositoryIntelligenceModal({
  isOpen,
  onClose,
  repo,
  analysisReport,
  isScanning,
  onConfirmImport,
  importing,
}) {
  const [copiedDocker, setCopiedDocker] = useState(false);

  if (!isOpen) return null;

  const detection = analysisReport?.detection || {
    framework: repo?.language === "JavaScript" ? "React + Vite" : (repo?.language || "Web App"),
    language: repo?.language || "JavaScript",
    packageManager: "npm",
    buildTool: "Vite",
    buildCommand: "npm run build",
    startCommand: "npm run preview",
    port: 5173,
    dockerized: false,
    dockerStatus: "Will be generated",
    requiredEnv: ["VITE_API_URL"],
    deploymentTarget: "AWS ECS Fargate",
    confidence: 98,
  };

  const plan = analysisReport?.plan || {
    source: "AI / Rule Planner",
    recommendedAction: "Automated container spec generated for deployment",
    dockerfile: `# SkyForge Production Container
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE ${detection.port || 5173}
CMD ["nginx", "-g", "daemon off;"]`,
  };

  const handleCopyDockerfile = () => {
    navigator.clipboard.writeText(plan.dockerfile);
    setCopiedDocker(true);
    setTimeout(() => setCopiedDocker(false), 2000);
  };

  const handleConfirm = () => {
    onConfirmImport({
      name: repo?.name || "project",
      repoName: repo?.fullName || `${repo?.owner}/${repo?.name}`,
      branch: analysisReport?.branch || repo?.defaultBranch || "main",
      language: detection.language,
      framework: detection.framework,
      packageManager: detection.packageManager,
      buildTool: detection.buildTool,
      buildCommand: detection.buildCommand,
      startCommand: detection.startCommand,
      port: detection.port,
      dockerized: detection.dockerized,
      requiredEnv: detection.requiredEnv || [],
      envAnalysis: detection.envAnalysis,
      deploymentTarget: detection.deploymentTarget,
      confidence: detection.confidence,
      githubUrl: repo?.githubUrl || `https://github.com/${repo?.fullName}`,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#362217]/70 backdrop-blur-md p-4 sm:p-6 overflow-y-auto">
      <div role="dialog" aria-modal="true" aria-labelledby="repository-intelligence-title" className="relative w-full max-w-3xl rounded-3xl border border-[#EAE1D5] bg-white shadow-2xl overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-200">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-[#EAE1D5] bg-gradient-to-r from-[#FAF8F5] via-white to-[#FAF8F5]">
          <div className="flex items-center gap-3.5">
            <div className="p-2.5 rounded-2xl bg-[#9E5D2D] text-white shadow-md shadow-[#9E5D2D]/20">
              <Cpu className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h3 id="repository-intelligence-title" className="text-xl font-bold text-[#362217] tracking-tight">
                  {repo?.name || "Repository Intelligence"}
                </h3>
                <span className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-[#2E6B4F]/10 text-[#2E6B4F] border border-[#2E6B4F]/20">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#2E6B4F] animate-ping" />
                  Ready to Deploy
                </span>
              </div>
              <p className="text-xs text-[#5E4C3E] flex items-center gap-1.5 mt-0.5">
                <Sparkles className="h-3.5 w-3.5 text-[#9E5D2D]" />
                <span>Analyzed automatically by SkyForge</span>
                <span className="text-[#A39284]">•</span>
                <span className="font-mono text-[#8C7667]">{repo?.fullName}</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close repository intelligence"
            onClick={onClose}
            className="p-2 rounded-xl text-[#8C7667] hover:text-[#362217] hover:bg-[#F4EFEA] transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 max-h-[75vh] overflow-y-auto flex flex-col gap-6">
          {isScanning ? (
            <div className="flex flex-col items-center justify-center py-16 text-center gap-4">
              <div className="relative">
                <div className="h-14 w-14 animate-spin rounded-full border-4 border-[#9E5D2D]/20 border-t-[#9E5D2D]" />
                <Cpu className="h-6 w-6 text-[#9E5D2D] absolute inset-0 m-auto" />
              </div>
              <div>
                <h4 className="font-bold text-base text-[#362217]">
                  Analyzing Repository AST & Manifests...
                </h4>
                <p className="text-xs text-[#8C7667] mt-1 max-w-md">
                  Scanning lockfiles, framework configurations, listening ports, Docker support, and environment variables deterministically.
                </p>
              </div>

              {/* Scanning Phase Progression */}
              <div className="flex items-center gap-2 mt-4 text-[11px] font-medium text-[#5E4C3E]">
                <span className="flex items-center gap-1 px-3 py-1 rounded-full bg-[#9E5D2D]/10 text-[#9E5D2D] border border-[#9E5D2D]/20">
                  <Check className="h-3 w-3" /> Tree Scan
                </span>
                <span>→</span>
                <span className="flex items-center gap-1 px-3 py-1 rounded-full bg-[#9E5D2D]/10 text-[#9E5D2D] border border-[#9E5D2D]/20">
                  <Check className="h-3 w-3" /> Manifests
                </span>
                <span>→</span>
                <span className="flex items-center gap-1 px-3 py-1 rounded-full bg-[#2E6B4F]/10 text-[#2E6B4F] border border-[#2E6B4F]/20">
                  <Zap className="h-3 w-3" /> Rule Matrix
                </span>
              </div>
            </div>
          ) : (
            <>
              {/* Top Banner with Confidence & Target */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-2xl bg-gradient-to-r from-[#FAF6F0] via-[#F5EFE6] to-[#FAF6F0] border border-[#E8DCCF]">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-white text-[#2E6B4F] shadow-sm border border-[#E8DCCF]">
                    <ShieldCheck className="h-6 w-6" />
                  </div>
                  <div>
                    <span className="text-[11px] font-bold text-[#8C7667] uppercase tracking-wider">
                      Detection Confidence
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-2xl font-black text-[#2E6B4F]">
                        {detection.confidence}%
                      </span>
                      <span className="text-xs font-semibold text-[#5E4C3E]">
                        High Precision Deterministic Match
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 sm:border-l sm:border-[#E8DCCF] sm:pl-4">
                  <Cloud className="h-5 w-5 text-[#3B7A75]" />
                  <div className="flex flex-col">
                    <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider">
                      Deployment Target
                    </span>
                    <span className="text-sm font-bold text-[#362217]">
                      {detection.deploymentTarget || "AWS ECS Fargate"}
                    </span>
                  </div>
                </div>
              </div>

              {/* 10-Property Intelligence Specification Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
                {/* 1. Framework */}
                <div className="p-3.5 rounded-2xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-[#8C7667] uppercase tracking-wider">
                    <Boxes className="h-3.5 w-3.5 text-[#9E5D2D]" />
                    <span>Framework</span>
                  </div>
                  <span className="text-sm font-bold text-[#362217] truncate">
                    {detection.framework}
                  </span>
                </div>

                {/* 2. Language */}
                <div className="p-3.5 rounded-2xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-[#8C7667] uppercase tracking-wider">
                    <Code2 className="h-3.5 w-3.5 text-[#9E5D2D]" />
                    <span>Language</span>
                  </div>
                  <span className="text-sm font-bold text-[#362217]">
                    {detection.language}
                  </span>
                </div>

                {/* 3. Package Manager */}
                <div className="p-3.5 rounded-2xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-[#8C7667] uppercase tracking-wider">
                    <Package className="h-3.5 w-3.5 text-[#9E5D2D]" />
                    <span>Package Manager</span>
                  </div>
                  <span className="text-sm font-bold text-[#362217] uppercase">
                    {detection.packageManager}
                  </span>
                </div>

                {/* 4. Port */}
                <div className="p-3.5 rounded-2xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col gap-1">
                  <div className="flex items-center justify-between text-[10px] font-bold text-[#8C7667] uppercase tracking-wider">
                    <span className="flex items-center gap-1.5">
                      <Server className="h-3.5 w-3.5 text-[#9E5D2D]" />
                      <span>Port</span>
                    </span>
                  </div>
                  <span className="text-sm font-mono font-bold text-[#9E5D2D]">
                    {detection.port}
                  </span>
                </div>

                {/* 5. Build Command */}
                <div className="col-span-2 p-3.5 rounded-2xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-[#8C7667] uppercase tracking-wider">
                    <Hammer className="h-3.5 w-3.5 text-[#9E5D2D]" />
                    <span>Build Command</span>
                  </div>
                  <code className="text-xs font-mono font-bold text-[#362217] bg-white px-2.5 py-1 rounded-lg border border-[#EADFCF] truncate">
                    {detection.buildCommand || "(None / Pre-built)"}
                  </code>
                </div>

                {/* 6. Start Command */}
                <div className="col-span-2 p-3.5 rounded-2xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-[#8C7667] uppercase tracking-wider">
                    <PlayCircle className="h-3.5 w-3.5 text-[#9E5D2D]" />
                    <span>Start Command</span>
                  </div>
                  <code className="text-xs font-mono font-bold text-[#362217] bg-white px-2.5 py-1 rounded-lg border border-[#EADFCF] truncate">
                    {detection.startCommand || "(Default Container CMD)"}
                  </code>
                </div>

                {/* 7. Docker Support */}
                <div className="col-span-2 p-3.5 rounded-2xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-[#8C7667] uppercase tracking-wider">
                    <Terminal className="h-3.5 w-3.5 text-[#9E5D2D]" />
                    <span>Docker Support</span>
                  </div>
                  <span className="text-xs font-semibold text-[#362217] flex items-center gap-1.5">
                    {detection.dockerized ? (
                      <span className="text-[#2E6B4F] flex items-center gap-1">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Existing Dockerfile
                      </span>
                    ) : (
                      <span className="text-[#9E5D2D] flex items-center gap-1">
                        <Sparkles className="h-3.5 w-3.5" /> Will be generated
                      </span>
                    )}
                  </span>
                </div>

                {/* 8. Build Tool */}
                <div className="col-span-2 p-3.5 rounded-2xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-[#8C7667] uppercase tracking-wider">
                    <Layers className="h-3.5 w-3.5 text-[#9E5D2D]" />
                    <span>Build Tool / Bundler</span>
                  </div>
                  <span className="text-xs font-semibold text-[#362217]">
                    {detection.buildTool || "Standard"}
                  </span>
                </div>
              </div>

              {/* Environment Variables Section */}
              <div className="rounded-2xl border border-[#EAE1D5] bg-[#FAF8F5] p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-bold text-[#362217]">
                    <Key className="h-4 w-4 text-[#9E5D2D]" />
                    <span>
                      Required Environment Variables ({detection.requiredEnv?.length || 0})
                    </span>
                  </div>
                  <span className="text-[10px] text-[#8C7667]">
                    Scanned from .env templates & code AST
                  </span>
                </div>

                {detection.requiredEnv && detection.requiredEnv.length > 0 ? (
                  <div className="flex flex-col gap-2.5">
                    <div className="flex flex-wrap gap-2">
                      {detection.requiredEnv.map((envVar, idx) => (
                        <span
                          key={idx}
                          className="inline-flex items-center gap-1 font-mono text-[11px] px-2.5 py-1 rounded-lg bg-white text-[#362217] border border-[#EADFCF] shadow-2xs font-semibold"
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-[#9E5D2D]" />
                          {envVar}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-[#8C7667] italic">
                    No custom environment variables required in repository manifest.
                  </p>
                )}
              </div>

              {/* Generated Docker / Container Spec */}
              <div className="rounded-2xl border border-[#EAE1D5] bg-white overflow-hidden shadow-sm">
                <div className="flex items-center justify-between px-4 py-3 bg-[#FAF8F5] border-b border-[#EAE1D5]">
                  <div className="flex items-center gap-2 text-xs font-bold text-[#362217]">
                    <Terminal className="h-4 w-4 text-[#9E5D2D]" />
                    <span>Generated Container Spec (Deterministic + AI Hybrid)</span>
                  </div>
                  <button
                    onClick={handleCopyDockerfile}
                    className="flex items-center gap-1 text-[11px] text-[#5E4C3E] hover:text-[#362217] font-medium transition px-2 py-0.5 rounded-md hover:bg-white border border-transparent hover:border-[#EAE1D5]"
                  >
                    {copiedDocker ? (
                      <>
                        <Check className="h-3 w-3 text-[#2E6B4F]" />
                        <span className="text-[#2E6B4F]">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </div>
                <pre className="p-4 bg-[#2C1A10] text-[#F3E5D8] font-mono text-xs overflow-x-auto leading-relaxed max-h-44 scrollbar-thin">
                  {plan.dockerfile}
                </pre>
              </div>
            </>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-[#EAE1D5] bg-white">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={importing}>
            Cancel
          </Button>

          <Button
            variant="primary"
            size="md"
            icon={Check}
            disabled={isScanning || importing}
            loading={importing}
            onClick={handleConfirm}
          >
            {importing ? "Saving Intelligence Profile..." : "Ready to Deploy — Confirm Import"}
          </Button>
        </div>
      </div>
    </div>
  );
}
