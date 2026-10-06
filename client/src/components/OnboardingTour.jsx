import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { X } from "lucide-react";
import { TOUR_EVENT } from "../utils/tour";

const STORAGE_KEY = "skyforge.tour";

// Each step points at an element marked data-tour="…". Steps whose element isn't visible (e.g. on a phone) are skipped.
const STEPS = [
  { target: "deploy", title: "Start here", body: "Pick a GitHub repository and SkyForge works out how to build it, then walks you through four short steps to put it online." },
  { target: "aws", title: "Your AWS account", body: "Sites run in your own AWS account, so you own everything and pay AWS directly. Green means it's connected." },
  { target: "github", title: "Your GitHub", body: "SkyForge reads your repositories from here. Turn on auto-deploy in a site's settings and every push goes live by itself." },
  { target: "search", title: "Find anything", body: "Press Ctrl+K (or /) to jump to any project, page, or AWS guide section." },
  { target: "notifications", title: "Stay in the loop", body: "When a deploy finishes or fails you get a pop-up here, even while you're on another page." },
  { target: "nav-costs", title: "No surprise bills", body: "See what AWS is charging, which site costs what, and set a monthly budget that warns you early." },
];

function visibleRect(name) {
  const element = [...document.querySelectorAll(`[data-tour="${name}"]`)].find((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth;
  });
  return element ? element.getBoundingClientRect() : null;
}

function readDone() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "done";
  } catch {
    return true; // storage blocked: don't nag on every visit
  }
}

/** A short spotlight tour of the dashboard, shown once and restartable from search or the overview page. */
export default function OnboardingTour() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState(null);

  const steps = open ? STEPS.filter((step) => visibleRect(step.target)) : [];
  const step = steps[index];

  const finish = useCallback(() => {
    setOpen(false);
    try {
      localStorage.setItem(STORAGE_KEY, "done");
    } catch {
      // Storage blocked: the tour may show again next visit.
    }
  }, []);

  // First visit to the overview: start automatically (after the page has painted).
  useEffect(() => {
    if (location.pathname !== "/dashboard" || readDone()) return undefined;
    const timer = window.setTimeout(() => {
      setIndex(0);
      setOpen(true);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [location.pathname]);

  useEffect(() => {
    const start = () => {
      setIndex(0);
      setOpen(true);
    };
    window.addEventListener(TOUR_EVENT, start);
    return () => window.removeEventListener(TOUR_EVENT, start);
  }, []);

  useLayoutEffect(() => {
    if (!open || !step) return undefined;
    const measure = () => setRect(visibleRect(step.target));
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, step]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") finish();
      if (event.key === "ArrowRight") setIndex((value) => Math.min(value + 1, steps.length - 1));
      if (event.key === "ArrowLeft") setIndex((value) => Math.max(value - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, finish, steps.length]);

  if (!open || !step || !rect) return null;

  const pad = 8;
  const hole = { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
  const cardWidth = Math.min(320, window.innerWidth - 32);
  const below = hole.top + hole.height + 12 + 190 < window.innerHeight;
  const cardTop = below ? hole.top + hole.height + 12 : Math.max(16, hole.top - 12 - 190);
  const cardLeft = Math.min(Math.max(16, hole.left), window.innerWidth - cardWidth - 16);
  const last = index === steps.length - 1;

  return createPortal(
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {/* The spotlight: a transparent box whose huge shadow darkens everything else. */}
      <div
        className="pointer-events-none absolute rounded-2xl transition-all duration-300 ease-out"
        style={{ ...hole, boxShadow: "0 0 0 9999px rgba(26, 18, 13, 0.62)", outline: "2px solid #E0A36E", outlineOffset: 2 }}
      />
      <div className="absolute inset-0" onClick={finish} aria-hidden="true" />
      <div
        className="page-enter absolute flex flex-col gap-3 rounded-2xl border border-[#EADFCF] bg-white p-4 shadow-2xl"
        style={{ top: cardTop, left: cardLeft, width: cardWidth }}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-[#9E5D2D]">Quick tour · {index + 1} of {steps.length}</p>
            <h2 id="tour-title" className="text-base font-bold text-[#362217]">{step.title}</h2>
          </div>
          <button type="button" onClick={finish} className="rounded-lg p-1 text-[#8C7667] hover:bg-[#FAF6F0] hover:text-[#362217]" aria-label="Close tour"><X className="h-4 w-4" /></button>
        </div>
        <p className="text-xs leading-relaxed text-[#5E4C3E]">{step.body}</p>
        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            {steps.map((item, dot) => <span key={item.target} className={`h-1.5 rounded-full transition-all ${dot === index ? "w-4 bg-[#9E5D2D]" : "w-1.5 bg-[#DCD0C3]"}`} />)}
          </div>
          <div className="flex gap-2">
            {index > 0 && <button type="button" onClick={() => setIndex(index - 1)} className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-[#5E4C3E] hover:bg-[#FAF6F0]">Back</button>}
            <button type="button" onClick={() => (last ? finish() : setIndex(index + 1))} className="rounded-lg bg-[#9E5D2D] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#8A5026]">{last ? "Done" : "Next"}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
