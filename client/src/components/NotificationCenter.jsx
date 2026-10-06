import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Bell, CheckCircle2, ExternalLink, Trash2, X } from "lucide-react";
import { getProjects } from "../services/api";
import { projectState } from "../utils/projectState";

const STORAGE_KEY = "skyforge.notifications";
const POLL_MS = 15_000;
const WORKING = new Set(["QUEUED", "BUILDING", "PUSHING", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "ROLLING_BACK", "DESTROYING"]);

// Browser storage can be unavailable (private windows, blocked site data); notifications still work in memory.
const readStored = () => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
};
const writeStored = (items) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 30)));
  } catch {
    // Storage blocked: keep the list in memory only.
  }
};

// Accent per kind; label colours are mid-tones that stay readable on both the light and dark card.
const TONES = {
  success: { color: "#2E6B4F", label: "#3F9A6E", text: "Deployment live" },
  error: { color: "#B3261E", label: "#D9534F", text: "Needs attention" },
  info: { color: "#9E5D2D", label: "#C27A43", text: "Update" },
};

/** What a finished deployment means for the person, or null for in-between states. */
function describe(project, deployment) {
  const status = deployment.status;
  if (status === "LIVE") return { kind: "success", title: `${project.name} is live`, body: deployment.liveUrl ? deployment.liveUrl.replace(/^https?:\/\//, "") : "The deployment finished.", url: deployment.liveUrl };
  if (status === "FAILED") return { kind: "error", title: `${project.name} failed to deploy`, body: "Open the console to see what went wrong." };
  if (status === "DESTROYED") return { kind: "info", title: `${project.name} was destroyed`, body: "All of its AWS resources were removed." };
  if (status === "DESTROY_FAILED") return { kind: "error", title: `Destroying ${project.name} failed`, body: "Some AWS resources may remain. Open the console to retry." };
  if (status === "ROLLED_BACK") return { kind: "info", title: `${project.name} was rolled back`, body: "The previous version is live again." };
  if (status === "CANCELLED") return { kind: "info", title: `${project.name}: deployment cancelled`, body: "" };
  return null;
}

/**
 * Watches every project's newest deployment and announces when one finishes: a toast on any page,
 * a list under the bell, and a system notification when the tab is in the background.
 */
export default function NotificationCenter() {
  const navigate = useNavigate();
  const [items, setItems] = useState(readStored);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const seen = useRef(null); // deploymentId -> status from the previous poll
  const [ring, setRing] = useState(0); // bumps on each announcement so the bell wiggles again
  const panelRef = useRef(null);

  const announce = useCallback((item) => {
    setItems((current) => {
      const next = [item, ...current].slice(0, 30);
      writeStored(next);
      return next;
    });
    setToast(item); // closes itself when its countdown bar runs out (paused while hovered)
    setRing((value) => value + 1);
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(item.title, { body: item.body, tag: item.id });
      } catch {
        // Some browsers only allow notifications from a service worker; the toast is enough.
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer;
    const poll = async () => {
      try {
        const projects = await getProjects();
        if (cancelled || !Array.isArray(projects)) return;
        const current = new Map();
        // Pull-request previews are nested under their main project; watch them too.
        for (const project of projects.flatMap((item) => [item, ...(item.previews || [])])) {
          const deployment = project.latestDeployment;
          if (!deployment) continue;
          current.set(deployment.id, deployment.status);
          const before = seen.current?.get(deployment.id);
          // First poll only records the starting point; afterwards a change out of a working state is news.
          if (seen.current && before !== deployment.status && (WORKING.has(before) || before === undefined) && !WORKING.has(deployment.status)) {
            const text = describe(project, deployment);
            if (text) announce({ ...text, id: `${deployment.id}-${deployment.status}`, projectId: project.id, state: projectState(project), at: new Date().toISOString(), read: false });
          }
        }
        seen.current = current;
      } catch {
        // Offline or signed out: try again on the next poll.
      }
      if (!cancelled) timer = window.setTimeout(poll, document.hidden ? POLL_MS * 2 : POLL_MS);
    };
    poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [announce]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!panelRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const unread = items.filter((item) => !item.read).length;
  const markAllRead = () => setItems((current) => {
    const next = current.map((item) => ({ ...item, read: true }));
    writeStored(next);
    return next;
  });
  const clear = () => {
    setItems([]);
    writeStored([]);
  };
  const go = (item) => {
    setOpen(false);
    setToast(null);
    navigate(`/project/${item.projectId}/deploy`);
  };
  const canAskPermission = "Notification" in window && Notification.permission === "default";
  const Icon = (kind) => (kind === "error" ? AlertTriangle : CheckCircle2);

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => {
          setOpen((value) => !value);
          if (!open && unread) markAllRead();
        }}
        className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-[#DCD0C3] bg-white text-[#5E4C3E] shadow-xs transition hover:text-[#362217]"
        aria-label={unread ? `${unread} new notifications` : "Notifications"}
        aria-expanded={open}
      >
        <Bell key={ring} className={`h-4 w-4 ${ring ? "bell-ring" : ""}`} />
        {unread > 0 && <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#9E2A2B] px-1 text-[9px] font-bold text-white">{unread}</span>}
      </button>

      {open && (
        <div className="page-enter absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-[#EADFCF] bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-[#F0E7DC] px-4 py-3">
            <span className="text-sm font-bold text-[#362217]">Notifications</span>
            {items.length > 0 && <button type="button" onClick={clear} className="flex items-center gap-1 text-[11px] font-semibold text-[#8C7667] hover:text-[#9E2A2B]"><Trash2 className="h-3 w-3" /> Clear</button>}
          </div>
          {canAskPermission && (
            <button type="button" onClick={() => Notification.requestPermission()} className="w-full border-b border-[#F0E7DC] bg-[#FFFBF6] px-4 py-2 text-left text-[11px] text-[#9E5D2D] hover:bg-[#FAF6F0]">
              Also notify me when SkyForge is in the background →
            </button>
          )}
          <ul className="max-h-80 overflow-auto">
            {items.length === 0 && <li className="px-4 py-6 text-center text-xs text-[#8C7667]">Nothing yet. You will be told here when a deployment finishes or fails.</li>}
            {items.map((item) => {
              const ItemIcon = Icon(item.kind);
              return (
                <li key={item.id}>
                  <button type="button" onClick={() => go(item)} className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-[#FAF6F0]">
                    <ItemIcon className={`mt-0.5 h-4 w-4 shrink-0 ${item.kind === "error" ? "text-[#9E2A2B]" : item.kind === "success" ? "text-[#2E6B4F]" : "text-[#8C7667]"}`} />
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold text-[#362217]">{item.title}</span>
                      {item.body && <span className="block truncate text-[11px] text-[#5E4C3E]">{item.body}</span>}
                      <span className="block text-[10px] text-[#A39284]">{new Date(item.at).toLocaleString()}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Portal: the header's backdrop blur would otherwise pin "fixed" to the header, not the window. */}
      {toast && createPortal(
        (() => {
          const tone = TONES[toast.kind] || TONES.info;
          const ToastIcon = Icon(toast.kind);
          return (
            <div
              key={toast.id}
              role="status"
              aria-live="polite"
              className="toast-pop fixed bottom-6 right-6 z-[60] w-[min(26rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border-2 bg-white"
              style={{ borderColor: tone.color, "--toast-color": `${tone.color}66` }}
            >
              <span className="absolute inset-y-0 left-0 w-1.5" style={{ background: tone.color }} />
              <div className="flex items-start gap-3 p-4 pl-5">
                <span className="relative mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white" style={{ background: tone.color }}>
                  <span className="toast-ping absolute inset-0 rounded-full" style={{ background: tone.color }} />
                  <ToastIcon className="relative h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: tone.label }}>{tone.text}</p>
                  <p className="text-[15px] font-bold leading-snug text-[#362217]">{toast.title}</p>
                  {toast.body && <p className="mt-0.5 truncate text-xs text-[#5E4C3E]">{toast.body}</p>}
                  <div className="mt-3 flex gap-2">
                    {toast.url && <a href={toast.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:brightness-110" style={{ background: tone.color }}><ExternalLink className="h-3.5 w-3.5" /> Open site</a>}
                    <button type="button" onClick={() => go(toast)} className="rounded-lg border border-[#DCD0C3] px-3 py-1.5 text-xs font-semibold text-[#5E4C3E] transition hover:bg-[#FAF6F0]">Open console</button>
                  </div>
                </div>
                <button type="button" onClick={() => setToast(null)} className="rounded-lg p-1 text-[#8C7667] transition hover:bg-[#FAF6F0] hover:text-[#362217]" aria-label="Dismiss"><X className="h-4 w-4" /></button>
              </div>
              <div className="h-1 bg-[#F0E7DC]">
                <div className="toast-progress h-full" style={{ background: tone.color }} onAnimationEnd={() => setToast(null)} />
              </div>
            </div>
          );
        })(),
        document.body,
      )}
    </div>
  );
}
