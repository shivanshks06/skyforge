export default function Card({
  children,
  className = "",
  hoverable = true,
  glow = false,
  ...props
}) {
  return (
    <div
      {...props}
      className={`relative overflow-hidden rounded-2xl border border-[#EAE1D5] bg-white p-6 backdrop-blur-xl shadow-sm transition-all duration-300 ${
        hoverable ? "hover:-translate-y-1 hover:border-[#D6C4B4] hover:shadow-lg hover:shadow-[#362217]/5" : ""
      } ${glow ? "shadow-[0_12px_40px_rgba(54,34,23,0.12)]" : ""} ${className}`}
    >
      {children}
    </div>
  );
}
