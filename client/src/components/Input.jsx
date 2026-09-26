import { useId } from "react";

export default function Input({
  label,
  error,
  icon: Icon,
  className = "",
  containerClassName = "",
  ...props
}) {
  const generatedId = useId();
  const inputId = props.id || generatedId;
  const errorId = `${inputId}-error`;
  return (
    <div className={`flex flex-col gap-1.5 ${containerClassName}`}>
      {label && (
        <label htmlFor={inputId} className="text-xs font-medium text-[#5E4C3E]">
          {label}
        </label>
      )}
      <div className="relative flex items-center">
        {Icon && (
          <div className="pointer-events-none absolute left-3.5 text-[#8C7667]">
            <Icon className="h-4 w-4" />
          </div>
        )}
        <input
          id={inputId}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? errorId : undefined}
          {...props}
          className={`w-full rounded-xl border border-[#DCD0C3] bg-white px-4 py-3 text-sm text-[#362217] placeholder-[#A39284] outline-none transition-all duration-200 focus:border-[#9E5D2D] focus:bg-white focus:ring-2 focus:ring-[#9E5D2D]/20 ${
            Icon ? "pl-10" : ""
          } ${error ? "border-red-500 focus:border-red-500 focus:ring-red-500/20" : ""} ${className}`}
        />
      </div>
      {error && (
        <span id={errorId} className="text-xs font-medium text-red-600">
          {error}
        </span>
      )}
    </div>
  );
}