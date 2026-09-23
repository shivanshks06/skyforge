import { Loader2 } from "lucide-react";

export default function Button({
  children,
  variant = "primary",
  size = "md",
  loading = false,
  disabled = false,
  icon: Icon,
  className = "",
  ...props
}) {
  const baseStyles =
    "relative inline-flex items-center justify-center font-medium transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-[#9E5D2D]/40 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] select-none";

  const variants = {
    primary:
      "bg-[#9E5D2D] hover:bg-[#8B5024] text-white shadow-md shadow-[#9E5D2D]/20 border border-[#8B5024]",
    secondary:
      "bg-white hover:bg-[#F4EFEA] text-[#362217] border border-[#DCD0C3] shadow-sm",
    outline:
      "bg-white hover:bg-[#F4EFEA] text-[#362217] border-2 border-[#362217] font-semibold",
    ghost:
      "bg-transparent text-[#5E4C3E] hover:text-[#362217] hover:bg-[#F4EFEA]",
    danger:
      "bg-red-600 hover:bg-red-700 text-white shadow-sm border border-red-700",
  };

  const sizes = {
    sm: "px-3.5 py-2 text-sm rounded-lg gap-2",
    md: "px-5 py-2.5 text-base rounded-xl gap-2",
    lg: "px-8 py-4 text-lg rounded-xl gap-2.5 font-semibold",
  };

  return (
    <button
      disabled={disabled || loading}
      className={`${baseStyles} ${variants[variant] || variants.primary} ${sizes[size] || sizes.md} ${className}`}
      {...props}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-current" />
      ) : Icon ? (
        <Icon className="h-4 w-4" />
      ) : null}
      <span>{children}</span>
    </button>
  );
}