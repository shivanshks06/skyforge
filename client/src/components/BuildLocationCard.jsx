import { useState } from "react";
import { CheckCircle2, Cloud, Laptop } from "lucide-react";
import Card from "./Card";
import { saveBuildMode } from "../services/api";

const OPTIONS = [
  {
    mode: "local",
    icon: Laptop,
    title: "On this computer",
    text: "Docker builds the image here, then uploads it to AWS. Fine on a fast connection; large images (1 GB+) upload slowly on home or mobile internet.",
    cost: "Free",
  },
  {
    mode: "cloud",
    icon: Cloud,
    title: "In AWS (CodeBuild)",
    text: "Only the source code is uploaded. AWS builds the image and stores it inside its own network, so deploys are fast and reliable from any connection, and Docker is not needed here.",
    cost: "≈ $0.01 per build minute · first 100 minutes a month free",
  },
];

/** Where the container image is built for ECS deployments. */
export default function BuildLocationCard({ projectId, initialMode = "local", onNotify }) {
  const [mode, setMode] = useState(initialMode || "local");
  const [saving, setSaving] = useState(false);

  const choose = async (next) => {
    if (next === mode) return;
    setSaving(true);
    try {
      const result = await saveBuildMode(projectId, next);
      setMode(result.mode);
      onNotify?.(result.message, "success");
    } catch (err) {
      onNotify?.(err.response?.data?.message || "Could not change where builds run.", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card glow={false} className="bg-white border border-[#EAE1D5] flex flex-col gap-4">
      <div>
        <h3 className="text-base font-bold text-[#362217]">Where to build</h3>
        <p className="text-xs text-[#5E4C3E]">Applies to ECS deployments. Static sites (S3 + CloudFront) are always built on this computer.</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {OPTIONS.map((option) => {
          const active = mode === option.mode;
          const Icon = option.icon;
          return (
            <button
              key={option.mode}
              type="button"
              aria-pressed={active}
              disabled={saving}
              onClick={() => choose(option.mode)}
              className={`text-left rounded-2xl border-2 p-4 flex flex-col gap-2 transition disabled:opacity-70 ${active ? "border-[#9E5D2D] bg-[#FFFBF6] ring-2 ring-[#9E5D2D]/15" : "border-[#EADFCF] bg-white hover:border-[#8C7667]"}`}
            >
              <span className="flex items-center justify-between gap-2 text-sm font-bold text-[#362217]">
                <span className="flex items-center gap-2"><Icon className="h-4 w-4 text-[#9E5D2D]" /> {option.title}</span>
                {active && <CheckCircle2 className="h-4 w-4 text-[#9E5D2D]" />}
              </span>
              <span className="text-xs text-[#5E4C3E]">{option.text}</span>
              <span className="text-[11px] font-mono text-[#8C7667]">{option.cost}</span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
