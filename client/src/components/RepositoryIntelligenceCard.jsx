import { Link } from "react-router-dom";
import {
  Cpu,
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
  CheckCircle2,
  Sparkles,
  FileCode,
  Container,
  Trash2,
  Rocket
} from "lucide-react";
import Card from "./Card";

export default function RepositoryIntelligenceCard({
  project,
  className = "",
  onDelete,
}) {
  if (!project) return null;

  return (
    <Card hoverable={false} className={`flex flex-col justify-between gap-5 bg-white border border-[#EAE1D5] ${className}`}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#EAE1D5] pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-[#9E5D2D]/10 text-[#9E5D2D] border border-[#9E5D2D]/20">
            <Cpu className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="font-bold text-base text-[#362217]">{project.name}</h4>
              <span className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#2E6B4F]/10 text-[#2E6B4F] border border-[#2E6B4F]/20">
                <CheckCircle2 className="h-3 w-3" /> {project.status || "Ready to Deploy"}
              </span>
            </div>
            <p className="text-[11px] text-[#8C7667] flex items-center gap-1 mt-0.5">
              <Sparkles className="h-3 w-3 text-[#9E5D2D]" />
              <span>Analyzed automatically by SkyForge</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {project.confidence && (
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-[#FAF6F0] border border-[#E8DCCF]">
              <ShieldCheck className="h-4 w-4 text-[#2E6B4F]" />
              <span className="text-xs font-bold text-[#2E6B4F]">{project.confidence}% Match</span>
            </div>
          )}
          {onDelete && (
            <button
              onClick={() => onDelete(project)}
              className="p-1.5 rounded-xl border border-[#EAE1D5] bg-white text-[#8C7667] hover:text-[#9E2A2B] hover:border-[#9E2A2B]/30 hover:bg-[#9E2A2B]/10 transition"
              title="Delete Project"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Grid of 8+ Detected Attributes */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        {/* Framework */}
        <div className="p-2.5 rounded-xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col gap-0.5">
          <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider flex items-center gap-1">
            <Boxes className="h-3 w-3 text-[#9E5D2D]" /> Framework
          </span>
          <span className="font-bold text-[#362217] truncate">{project.framework || "N/A"}</span>
        </div>

        {/* Language */}
        <div className="p-2.5 rounded-xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col gap-0.5">
          <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider flex items-center gap-1">
            <Code2 className="h-3 w-3 text-[#9E5D2D]" /> Language
          </span>
          <span className="font-bold text-[#362217] truncate">{project.language || "N/A"}</span>
        </div>

        {/* Package Manager */}
        <div className="p-2.5 rounded-xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col gap-0.5">
          <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider flex items-center gap-1">
            <Package className="h-3 w-3 text-[#9E5D2D]" /> Package Manager
          </span>
          <span className="font-bold text-[#362217] uppercase truncate">{project.packageManager || "npm"}</span>
        </div>

        {/* Port */}
        <div className="p-2.5 rounded-xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col gap-0.5">
          <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider flex items-center gap-1">
            <Server className="h-3 w-3 text-[#9E5D2D]" /> Port
          </span>
          <span className="font-bold text-[#9E5D2D] font-mono">{project.port || 5173}</span>
        </div>

        {/* Build Command */}
        <div className="col-span-2 p-2.5 rounded-xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col gap-0.5">
          <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider flex items-center gap-1">
            <Hammer className="h-3 w-3 text-[#9E5D2D]" /> Build Command
          </span>
          <code className="font-mono text-[11px] font-bold text-[#362217] truncate bg-white px-2 py-0.5 rounded border border-[#EADFCF]">
            {project.buildCommand || "(None / Pre-built)"}
          </code>
        </div>

        {/* Start Command */}
        <div className="col-span-2 p-2.5 rounded-xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col gap-0.5">
          <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider flex items-center gap-1">
            <PlayCircle className="h-3 w-3 text-[#9E5D2D]" /> Start Command
          </span>
          <code className="font-mono text-[11px] font-bold text-[#362217] truncate bg-white px-2 py-0.5 rounded border border-[#EADFCF]">
            {project.startCommand || "(Default Container CMD)"}
          </code>
        </div>

        {/* Docker */}
        <div className="col-span-2 p-2.5 rounded-xl bg-[#FAF8F5] border border-[#EAE1D5] flex items-center justify-between">
          <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider flex items-center gap-1">
            <Terminal className="h-3 w-3 text-[#9E5D2D]" /> Docker
          </span>
          <span className="text-[11px] font-semibold text-[#362217]">
            {project.dockerized ? "Existing Dockerfile" : "Will be generated"}
          </span>
        </div>

        {/* Deployment Target */}
        <div className="col-span-2 p-2.5 rounded-xl bg-[#FAF8F5] border border-[#EAE1D5] flex items-center justify-between">
          <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider flex items-center gap-1">
            <Cloud className="h-3 w-3 text-[#3B7A75]" /> Deployment Target
          </span>
          <span className="text-[11px] font-bold text-[#362217]">
            {project.deploymentTarget || "AWS ECS Fargate"}
          </span>
        </div>
      </div>

      {/* Required Environment Variables if present */}
      {project.requiredEnv && project.requiredEnv.length > 0 && (
        <div className="flex flex-col gap-1.5 pt-2 border-t border-[#EAE1D5]">
          <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider flex items-center gap-1">
            <Layers className="h-3 w-3 text-[#9E5D2D]" /> Required Environment Variables ({project.requiredEnv.length})
          </span>
          <div className="flex flex-wrap gap-1.5">
            {project.requiredEnv.map((v, i) => (
              <span key={i} className="font-mono text-[10px] px-2 py-0.5 rounded bg-[#FAF8F5] border border-[#EAE1D5] text-[#362217] font-semibold">
                {v}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Action to view AI Plan & Blueprint */}
      <div className="flex flex-wrap items-center justify-end gap-2 pt-3 border-t border-[#EAE1D5]">
        <Link
          to={`/project/${project.id}/infrastructure`}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg border-2 border-[#362217] bg-white px-3.5 py-2 text-sm font-semibold text-[#362217] transition hover:bg-[#F4EFEA] sm:w-auto"
        >
          <Cloud className="h-4 w-4" /> AWS Infra
        </Link>
        <Link
          to={`/project/${project.id}/docker`}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg border-2 border-[#362217] bg-white px-3.5 py-2 text-sm font-semibold text-[#362217] transition hover:bg-[#F4EFEA] sm:w-auto"
        >
          <Container className="h-4 w-4" /> Dockerfile
        </Link>
        <Link
          to={`/project/${project.id}/plan`}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg border-2 border-[#362217] bg-white px-3.5 py-2 text-sm font-semibold text-[#362217] transition hover:bg-[#F4EFEA] sm:w-auto"
        >
          <FileCode className="h-4 w-4" /> AI Plan
        </Link>
        <Link
          to={`/project/${project.id}/deploy`}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[#8B5024] bg-[#9E5D2D] px-3.5 py-2 text-sm font-medium text-white shadow-md transition hover:bg-[#8B5024] sm:w-auto"
        >
          <Rocket className="h-4 w-4" /> Deploy
        </Link>
      </div>
    </Card>
  );
}
