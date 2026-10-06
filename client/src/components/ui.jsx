import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Check, Copy, Info, AlertTriangle, CheckCircle2 } from "lucide-react";

/** Page title row: back button, icon, title, subtitle, and actions on the right. */
export function PageHeader({ icon: Icon, title, subtitle, back, actions }) {
  const navigate = useNavigate();
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        {back && (
          <button type="button" onClick={() => (back === true ? navigate(-1) : navigate(back))} className="mt-0.5 rounded-xl border border-[#DCD0C3] bg-white p-2 text-[#5E4C3E] transition hover:text-[#362217]" aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-2xl font-bold text-[#362217]">
            {Icon && <Icon className="h-6 w-6 shrink-0 text-[#9E5D2D]" />}
            <span className="truncate">{title}</span>
          </h2>
          {subtitle && <p className="mt-1 text-sm text-[#5E4C3E]">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A white section card with an optional heading row. */
export function Panel({ title, icon: Icon, description, actions, children, className = "", id }) {
  return (
    <section id={id} className={`rounded-3xl border border-[#EAE1D5] bg-white p-5 sm:p-6 ${className}`}>
      {(title || actions) && (
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            {title && (
              <h3 className="flex items-center gap-2 text-base font-bold text-[#362217]">
                {Icon && <Icon className="h-4.5 w-4.5 h-[18px] w-[18px] text-[#9E5D2D]" />}
                {title}
              </h3>
            )}
            {description && <p className="mt-1 text-xs leading-relaxed text-[#5E4C3E]">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** An accessible on/off switch. */
export function Toggle({ checked, onChange, disabled = false, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${checked ? "bg-[#2E6B4F]" : "bg-[#D8CCC0]"} ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  );
}

/** Copies text and briefly shows a tick. */
export function CopyButton({ value, label = "Copy", className = "" }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard blocked (insecure context): the value is visible to copy by hand.
        }
      }}
      className={`inline-flex items-center gap-1 rounded-lg border border-[#DCD0C3] bg-white px-2 py-1 text-[11px] font-semibold text-[#5E4C3E] transition hover:bg-[#FAF6F0] ${className}`}
      title={`Copy ${value}`}
    >
      {copied ? <Check className="h-3 w-3 text-[#2E6B4F]" /> : <Copy className="h-3 w-3" />} {copied ? "Copied" : label}
    </button>
  );
}

const NOTICE = {
  info: { icon: Info, className: "border-[#9E5D2D]/20 bg-[#9E5D2D]/5 text-[#5E4C3E]", iconClass: "text-[#9E5D2D]" },
  warn: { icon: AlertTriangle, className: "border-amber-500/30 bg-amber-500/10 text-[#5E4C3E]", iconClass: "text-amber-600" },
  error: { icon: AlertTriangle, className: "border-[#9E2A2B]/25 bg-[#9E2A2B]/5 text-[#5E4C3E]", iconClass: "text-[#9E2A2B]" },
  success: { icon: CheckCircle2, className: "border-[#2E6B4F]/25 bg-[#2E6B4F]/5 text-[#5E4C3E]", iconClass: "text-[#2E6B4F]" },
};

export function Notice({ kind = "info", children, className = "" }) {
  const style = NOTICE[kind] || NOTICE.info;
  const Icon = style.icon;
  return (
    <div className={`flex items-start gap-2 rounded-2xl border px-3.5 py-2.5 text-xs leading-relaxed ${style.className} ${className}`}>
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.iconClass}`} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
