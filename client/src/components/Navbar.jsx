import { Link } from "react-router-dom";
import Logo from "./Logo";
import { ArrowRight } from "lucide-react";

export default function Navbar() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-[#EADFCF] bg-[#FAF8F5]/85 backdrop-blur-xl">
      <div className="w-full flex items-center justify-between px-6 sm:px-12 py-4">
        <Logo />

        <div className="flex items-center gap-6">
          <Link
            to="/login"
            className="text-base font-medium text-[#362217] transition hover:text-[#9E5D2D]"
          >
            Sign in
          </Link>

          <Link
            to="/signup"
            className="inline-flex items-center gap-2 rounded-lg border border-[#8B5024] bg-[#9E5D2D] px-3.5 py-2 text-sm font-medium text-white shadow-md transition hover:bg-[#8B5024]"
          >
            Get Started <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </header>
  );
}