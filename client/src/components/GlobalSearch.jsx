import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Activity, BookOpen, Compass, FileCode, FolderGit2, LayoutDashboard, Rocket, Search, Settings, Settings2, Shield, Terminal, Wallet, X } from "lucide-react";
import { getProjects } from "../services/api";
import { AWS_GUIDE_SECTIONS } from "../data/awsGuideSections";
import { startTour } from "../utils/tour";

const PAGES = [
  { label: "Overview", path: "/dashboard", icon: LayoutDashboard, keywords: "home dashboard overview" },
  { label: "Projects", path: "/dashboard/projects", icon: FolderGit2, keywords: "projects repositories apps new import" },
  { label: "Deployments", path: "/dashboard/deployments", icon: Rocket, keywords: "deployments history releases" },
  { label: "Settings", path: "/dashboard/settings", icon: Settings, keywords: "settings aws connection credentials github alerts email slack discord telegram profile" },
  { label: "AWS guide", path: "/dashboard/aws-guide", icon: BookOpen, keywords: "aws guide help verification setup account" },
  { label: "Deploy a new site", path: "/dashboard/new", icon: Rocket, keywords: "new deploy wizard create site add repository" },
  { label: "Costs", path: "/dashboard/costs", icon: Wallet, keywords: "costs billing spend money budget price aws bill" },
  { label: "Take the tour", action: "tour", icon: Compass, keywords: "tour help guide onboarding introduction walkthrough" },
];

// Per-project destinations: "lexa security" opens that project's Security page.
const PROJECT_PAGES = [
  { label: "Deployment console", suffix: "deploy", icon: Terminal, keywords: "deploy console logs destroy rollback" },
  { label: "Security", suffix: "security", icon: Shield, keywords: "security firewall waf incidents scan offline" },
  { label: "Environment & database", suffix: "plan", icon: FileCode, keywords: "environment env variables database plan secrets keys" },
  { label: "Infrastructure", suffix: "infrastructure", icon: FolderGit2, keywords: "infrastructure target cloudfront ecs s3 build terraform cost" },
  { label: "Monitoring", suffix: "monitor", icon: Activity, keywords: "monitoring metrics logs app logs cpu memory traffic uptime errors" },
  { label: "Site settings", suffix: "settings", icon: Settings2, keywords: "settings auto deploy push previews pull request domain https port size memory cpu status page" },
];

const normalize = (value) => String(value || "").toLowerCase();

function score(haystack, tokens) {
  if (!tokens.length) return 0;
  let total = 0;
  for (const token of tokens) {
    const index = haystack.indexOf(token);
    if (index < 0) return -1;
    total += index === 0 ? 3 : haystack.includes(` ${token}`) ? 2 : 1;
  }
  return total;
}

/** Global search: projects, project pages, app pages and AWS guide topics. Ctrl+K or "/" focuses it. */
export default function GlobalSearch({ compact = false }) {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(!compact);
  const [projects, setProjects] = useState(null);
  const [active, setActive] = useState(0);

  const loadProjects = useCallback(() => {
    getProjects().then((data) => setProjects(Array.isArray(data) ? data : [])).catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "") || document.activeElement?.isContentEditable;
      if ((event.key === "k" && (event.ctrlKey || event.metaKey)) || (event.key === "/" && !typing)) {
        event.preventDefault();
        setExpanded(true);
        window.setTimeout(() => inputRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo(() => {
    const tokens = normalize(query).split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    const items = [];
    for (const project of projects || []) {
      const base = normalize(`${project.name} ${project.repoName} ${project.framework} ${project.language} ${project.status} ${project.deploymentTarget}`);
      const own = score(base, tokens);
      if (own >= 0) items.push({ key: `p-${project.id}`, kind: "Project", label: project.name, detail: `${project.repoName || ""}${project.framework ? ` · ${project.framework}` : ""}${project.status ? ` · ${project.status}` : ""}`, path: `/project/${project.id}/deploy`, icon: FolderGit2, rank: own + 4 });
      for (const page of PROJECT_PAGES) {
        const pageScore = score(`${base} ${normalize(page.label)} ${page.keywords}`, tokens);
        // Show project sub-pages only when the query names something beyond the project itself.
        if (pageScore >= 0 && own < 0) items.push({ key: `p-${project.id}-${page.suffix}`, kind: project.name, label: page.label, detail: project.repoName, path: `/project/${project.id}/${page.suffix}`, icon: page.icon, rank: pageScore + 2 });
      }
    }
    for (const page of PAGES) {
      const pageScore = score(`${normalize(page.label)} ${page.keywords}`, tokens);
      if (pageScore >= 0) items.push({ key: `page-${page.path || page.action}`, kind: page.action ? "Action" : "Page", label: page.label, path: page.path, action: page.action, icon: page.icon, rank: pageScore + 1 });
    }
    for (const section of AWS_GUIDE_SECTIONS) {
      const sectionScore = score(`${normalize(section.title)} aws guide ${section.keywords}`, tokens);
      if (sectionScore >= 0) items.push({ key: `guide-${section.id}`, kind: "AWS guide", label: section.title, path: `/dashboard/aws-guide#${section.id}`, icon: BookOpen, rank: sectionScore });
    }
    return items.sort((a, b) => b.rank - a.rank || a.label.localeCompare(b.label)).slice(0, 10);
  }, [query, projects]);

  const go = (item) => {
    if (!item) {
      const text = query.trim();
      navigate(text ? `/dashboard/projects?search=${encodeURIComponent(text)}` : "/dashboard/projects");
    } else if (item.action === "tour") {
      startTour();
    } else {
      navigate(item.path);
    }
    setQuery("");
    setOpen(false);
    if (compact) setExpanded(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, Math.max(results.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(results[active]);
    } else if (event.key === "Escape") {
      setOpen(false);
      setQuery("");
      inputRef.current?.blur();
      if (compact) setExpanded(false);
    }
  };

  if (compact && !expanded) {
    return (
      <button type="button" onClick={() => { setExpanded(true); window.setTimeout(() => inputRef.current?.focus(), 0); }} className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#DCD0C3] bg-white text-[#5E4C3E] shadow-xs" aria-label="Search">
        <Search className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div className={`${compact ? "fixed inset-x-3 top-3 z-50" : "relative"}`} role="search">
      <div className="relative flex items-center">
        <Search className="pointer-events-none absolute left-3 h-4 w-4 text-[#8C7667]" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            if (projects === null) loadProjects();
          }}
          onBlur={() => window.setTimeout(() => {
            setOpen(false);
            if (compact && !query) setExpanded(false);
          }, 150)}
          onKeyDown={onKeyDown}
          placeholder="Search projects, pages, AWS guide..."
          aria-label="Search"
          aria-expanded={open && Boolean(query)}
          aria-controls="global-search-results"
          aria-activedescendant={results[active] ? `search-${results[active].key}` : undefined}
          role="combobox"
          className={`${compact ? "w-full shadow-lg" : "w-72"} rounded-xl border border-[#DCD0C3] bg-white pl-9 pr-16 py-2 text-xs text-[#362217] placeholder-[#A39284] outline-none focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D]`}
        />
        {compact ? (
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { setQuery(""); setExpanded(false); }} className="absolute right-2 p-1 text-[#8C7667]" aria-label="Close search"><X className="h-4 w-4" /></button>
        ) : (
          <kbd className="pointer-events-none absolute right-2 rounded border border-[#EADFCF] bg-[#FAF8F5] px-1.5 py-0.5 text-[10px] font-mono text-[#8C7667]">Ctrl K</kbd>
        )}
      </div>
      {open && query.trim() && (
        <ul id="global-search-results" role="listbox" className="absolute right-0 z-50 mt-2 w-full min-w-[20rem] max-h-96 overflow-auto rounded-xl border border-[#EADFCF] bg-white py-1 shadow-xl">
          {projects === null && <li className="px-3 py-2 text-xs text-[#8C7667]">Loading projects...</li>}
          {results.map((item, index) => {
            const Icon = item.icon;
            return (
              <li
                key={item.key}
                id={`search-${item.key}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => go(item)}
                className={`flex cursor-pointer items-center gap-3 px-3 py-2 ${index === active ? "bg-[#FAF6F0]" : ""}`}
              >
                <Icon className="h-4 w-4 shrink-0 text-[#9E5D2D]" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-xs font-semibold text-[#362217]">{item.label}</span>
                  {item.detail && <span className="truncate text-[11px] text-[#8C7667]">{item.detail}</span>}
                </span>
                <span className="ml-auto shrink-0 rounded-full bg-[#FAF8F5] px-2 py-0.5 text-[10px] font-semibold text-[#8C7667]">{item.kind}</span>
              </li>
            );
          })}
          {projects !== null && !results.length && (
            <li className="px-3 py-2 text-xs text-[#8C7667]">No matches. Press Enter to search project names on the Projects page.</li>
          )}
        </ul>
      )}
    </div>
  );
}
