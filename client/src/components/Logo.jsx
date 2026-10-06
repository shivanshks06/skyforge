import { Cpu } from "lucide-react";
import { Link } from "react-router-dom";

/** tone="light" is for dark backgrounds such as the dashboard sidebar. */
export default function Logo({ className = "", showIcon = true, tone = "dark" }) {
  return (
    <Link to="/" className={`group flex items-center gap-3 select-none ${className}`}>
      {showIcon && (
        <div className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-[#362217]/20 bg-[#FAF8F5] p-[1px] shadow-sm transition-all duration-300 group-hover:border-[#9E5D2D] group-hover:shadow-md">
          <div className="flex h-full w-full items-center justify-center rounded-[11px] bg-white text-[#362217]">
            <Cpu className="h-5 w-5 text-[#362217] transition-transform duration-300 group-hover:rotate-12 group-hover:text-[#9E5D2D]" />
          </div>
        </div>
      )}
      <span className={`text-2xl font-extrabold tracking-tight ${tone === "light" ? "text-white" : "text-[#362217]"}`}>
        Sky<span className={tone === "light" ? "text-[#E0A36E]" : "text-[#9E5D2D]"}>Forge</span>
      </span>
    </Link>
  );
}