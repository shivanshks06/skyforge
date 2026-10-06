import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

const KEY = "skyforge.theme";
const saved = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

/** Light/dark switch. Follows the system setting until the person picks one. */
export default function ThemeToggle({ className = "" }) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#14100D" : "#FAF8F5");
  }, [dark]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = (event) => {
      if (!saved()) setDark(event.matches);
    };
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    try {
      localStorage.setItem(KEY, next ? "dark" : "light");
    } catch {
      // Storage blocked: the choice lasts for this visit only.
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className={`flex h-9 w-9 items-center justify-center rounded-xl border border-[#DCD0C3] bg-white text-[#5E4C3E] shadow-xs transition hover:text-[#362217] ${className}`}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
