import { Check, Cloud, Lock, Server, Unlock, Zap } from "lucide-react";
import Card from "./Card";

const ICONS = { AWS_ECS_FARGATE: Server, AWS_ECS_CLOUDFRONT: Zap, AWS_S3_CLOUDFRONT: Cloud };

/**
 * The three deployment targets. Nothing is preselected: a project deploys only after its owner
 * picks one here.
 */
export default function TargetChooser({ choices = [], selected, onChoose, busy }) {
  return (
    <Card glow={false} className="bg-gradient-to-r from-[#FAF6F0] via-white to-[#FAF6F0] border border-[#EADFCF] flex flex-col gap-4">
      <div>
        <h3 className="text-base font-bold text-[#362217]">Choose where to deploy</h3>
        <p className="text-xs text-[#5E4C3E] mt-0.5">
          {selected ? "You can switch between the two ECS options at any time; switching to or from S3 needs the current deployment destroyed first." : "No target is selected yet. Pick one to see its architecture, cost, and to enable deployment."}
        </p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {choices.map((choice) => {
          const Icon = ICONS[choice.id] || Server;
          const active = selected === choice.id;
          return (
            <button
              key={choice.id}
              type="button"
              aria-pressed={active}
              disabled={busy || !choice.suitable}
              onClick={() => onChoose(choice.id)}
              className={`text-left p-4 rounded-2xl border-2 transition flex flex-col gap-3 disabled:cursor-not-allowed ${
                active ? "bg-white border-[#9E5D2D] ring-2 ring-[#9E5D2D]/20" : choice.suitable ? "bg-white/70 border-[#EADFCF] hover:border-[#8C7667]" : "bg-[#FAF8F5] border-[#EADFCF] opacity-60"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="flex items-center gap-2 text-sm font-bold text-[#362217]">
                  <span className="p-1.5 rounded-lg bg-[#9E5D2D]/10 text-[#9E5D2D]"><Icon className="h-4 w-4" /></span>
                  {choice.label}
                </span>
                <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${active ? "border-[#9E5D2D] bg-[#9E5D2D] text-white" : "border-[#8C7667]"}`}>
                  {active && <Check className="h-3 w-3 stroke-[3]" />}
                </span>
              </div>
              <p className="text-xs text-[#5E4C3E]">{choice.summary}</p>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-bold ${choice.https ? "bg-[#2E6B4F]/10 text-[#2E6B4F]" : "bg-amber-500/10 text-amber-700"}`}>
                  {choice.https ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                  {choice.https ? "HTTPS" : "HTTP only"}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-[#FAF8F5] border border-[#EAE1D5] text-[#5E4C3E] font-semibold">
                  {choice.supports === "static" ? "Static sites only" : "Any app"}
                </span>
              </div>
              <span className="text-[11px] font-mono text-[#362217]">{choice.cost}</span>
              {choice.note && <span className="text-[11px] text-amber-700">{choice.note}</span>}
              {choice.https && <span className="text-[10px] text-[#8C7667]">HTTPS needs CloudFront enabled on your AWS account; until then the site is served over HTTP automatically.</span>}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
