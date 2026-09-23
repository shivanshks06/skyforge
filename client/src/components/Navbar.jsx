import { Link } from "react-router-dom";
import Logo from "./Logo";
import Button from "./Button";
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

          <Link to="/signup">
            <Button size="sm" icon={ArrowRight}>
              Get Started
            </Button>
          </Link>
        </div>
      </div>
    </header>
  );
}