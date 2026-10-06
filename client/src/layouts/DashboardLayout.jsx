import { Outlet, Link, useLocation, useNavigate } from "react-router-dom";
import { useContext, useEffect, useState } from "react";
import { AuthContext } from "../context/authContext.js";
import { getAwsStatus, getGithubLoginUrl } from "../services/api";
import Logo from "../components/Logo";
import GlobalSearch from "../components/GlobalSearch";
import NotificationCenter from "../components/NotificationCenter";
import ThemeToggle from "../components/ThemeToggle";
import OnboardingTour from "../components/OnboardingTour";
import {
  LayoutDashboard,
  FolderGit2,
  Rocket,
  Settings,
  LogOut,
  BookOpen,
  ShieldCheck,
  GitPullRequest,
  CheckCircle2,
  Menu,
  Wallet,
  X
} from "lucide-react";

export default function DashboardLayout() {
  const { logout, user, isGithubConnected, githubAccount } = useContext(AuthContext);
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [aws, setAws] = useState(null);

  // The header badge shows the real AWS connection, refreshed on each page change.
  useEffect(() => {
    let cancelled = false;
    getAwsStatus().then((status) => !cancelled && setAws(status)).catch(() => !cancelled && setAws({ connected: false }));
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  const navItems = [
    { label: "Overview", path: "/dashboard", icon: LayoutDashboard },
    { label: "Projects", path: "/dashboard/projects", icon: FolderGit2 },
    { label: "Deployments", path: "/dashboard/deployments", icon: Rocket },
    { label: "Costs", path: "/dashboard/costs", icon: Wallet },
    { label: "AWS Guide", path: "/dashboard/aws-guide", icon: BookOpen },
    { label: "Settings", path: "/dashboard/settings", icon: Settings },
  ];

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const handleConnectGitHub = async () => {
    try {
      window.location.assign(await getGithubLoginUrl());
    } catch (error) {
      console.error("Unable to start GitHub authorization:", error);
    }
  };

  const getPageTitle = () => {
    const path = location.pathname;
    if (path === "/dashboard/deployments") return "Deployments";
    if (path === "/dashboard/projects") return "Projects";
    if (path === "/dashboard/settings") return "Settings";
    if (path === "/dashboard/aws-guide") return "AWS Guide";
    if (path === "/dashboard/new") return "Deploy a new site";
    if (path === "/dashboard/costs") return "Costs";
    if (path.includes("/monitor")) return "Monitoring";
    if (path.includes("/settings") && path.startsWith("/project/")) return "Site settings";
    if (path.includes("/security")) return "Security";
    if (path.includes("/deploy")) return "Deployment Console";
    if (path.includes("/plan")) return "AI Deployment Plan";
    if (path.includes("/docker")) return "Dockerfile Preview";
    if (path.includes("/infrastructure")) return "Cloud Infrastructure";
    return "Overview";
  };

  return (
    <div className="app-bg flex h-screen bg-[#FAF8F5] text-[#362217] selection:bg-[#9E5D2D]/20 overflow-hidden">
      {/* Mobile Backdrop */}
      {mobileMenuOpen && (
        <div
          onClick={() => setMobileMenuOpen(false)}
          className="fixed inset-0 z-40 bg-[#362217]/50 backdrop-blur-xs md:hidden"
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 border-r border-[#2A1910] bg-[#362217] text-white flex flex-col justify-between transition-transform duration-300 md:static md:translate-x-0 ${
          mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div>
          <div className="p-6 border-b border-[#4D3325] flex items-center justify-between">
            <Logo tone="light" />
            <button
              onClick={() => setMobileMenuOpen(false)}
              className="p-1.5 rounded-lg text-[#BFAEA0] hover:text-white md:hidden"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <nav className="p-4 flex flex-col gap-1.5">
            <Link
              to="/dashboard/new"
              data-tour="deploy"
              onClick={() => setMobileMenuOpen(false)}
              className="keep-colors mb-2 flex items-center justify-center gap-2 rounded-xl bg-[#E0A36E] px-4 py-2.5 text-sm font-bold text-[#2C1B12] shadow-sm transition hover:bg-[#EBB585]"
            >
              <Rocket className="h-4 w-4" /> Deploy a new site
            </Link>
            {navItems.map((item) => {
              const isActive =
                item.path === "/dashboard"
                  ? location.pathname === "/dashboard"
                  : item.path === "/dashboard/projects"
                     ? location.pathname.startsWith("/dashboard/projects") || location.pathname.startsWith("/project/")
                     : location.pathname.startsWith(item.path);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  data-tour={`nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-all duration-200 ${
                    isActive
                      ? "bg-[#9E5D2D] text-white shadow-sm"
                      : "text-[#D8CCC0] hover:bg-[#4D3325]/50 hover:text-white"
                  }`}
                >
                  <item.icon className={`h-4 w-4 ${isActive ? "text-white" : "text-[#BFAEA0]"}`} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Sidebar Footer User Area */}
        <div className="p-4 border-t border-[#4D3325]">
          <div className="mb-3 flex items-center gap-3 px-3 py-2 rounded-xl bg-[#2C1B12] border border-[#4D3325]">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#9E5D2D] font-bold text-xs text-white">
              {user?.name?.charAt(0)?.toUpperCase() || "U"}
            </div>
            <div className="flex flex-col min-w-0 flex-1">
              <span className="text-xs font-semibold text-white truncate">{user?.name || "User"}</span>
              {user?.email && <span className="text-[10px] text-[#D8CCC0] truncate">{user.email}</span>}
            </div>
          </div>

          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-xs font-medium text-[#D8CCC0] transition hover:bg-red-500/20 hover:text-red-300"
          >
            <LogOut className="h-4 w-4" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Header */}
        {/* relative + z-40: the header's backdrop blur creates its own stacking context, so without
            a z-index the page content below would paint over the search results dropdown. */}
        <header className="app-header relative z-40 h-20 border-b border-[#EADFCF] bg-[#FAF8F5]/90 backdrop-blur-xl flex items-center justify-between px-6 sm:px-8">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="p-2 rounded-xl border border-[#DCD0C3] bg-white text-[#5E4C3E] hover:text-[#362217] md:hidden shadow-xs"
            >
              <Menu className="h-5 w-5" />
            </button>
            <h1 className="text-lg font-bold text-[#362217]">{getPageTitle()}</h1>

            {/* AWS connection badge */}
            {aws && (aws.connected ? (
              <Link to="/dashboard/settings" data-tour="aws" title="AWS connection settings" className="hidden sm:flex items-center gap-1.5 rounded-full border border-[#2E6B4F]/30 bg-[#2E6B4F]/10 px-3 py-1 text-xs text-[#2E6B4F] font-semibold transition hover:bg-[#2E6B4F]/15">
                <ShieldCheck className="h-3.5 w-3.5" />
                <span>AWS{aws.accountId ? ` • …${String(aws.accountId).slice(-4)}` : ""}{aws.region ? ` • ${aws.region}` : ""}</span>
              </Link>
            ) : (
              <Link to="/dashboard/settings" data-tour="aws" className="hidden sm:flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs text-amber-700 font-semibold transition hover:bg-amber-500/20">
                <ShieldCheck className="h-3.5 w-3.5" />
                <span>Connect AWS</span>
              </Link>
            ))}

            {/* GitHub Connection Sync Status */}
            {isGithubConnected ? (
              <div data-tour="github" className="hidden lg:flex items-center gap-1.5 rounded-full border border-[#2E6B4F]/30 bg-[#2E6B4F]/10 px-3 py-1 text-xs text-[#2E6B4F] font-semibold">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>GitHub • @{githubAccount?.username || user?.github?.username || "connected"}</span>
              </div>
            ) : (
              <button
                data-tour="github"
                onClick={handleConnectGitHub}
                className="hidden lg:flex items-center gap-1.5 rounded-full border border-[#9E5D2D]/30 bg-[#9E5D2D]/10 hover:bg-[#9E5D2D]/20 px-3 py-1 text-xs text-[#9E5D2D] font-semibold transition"
              >
                <GitPullRequest className="h-3.5 w-3.5" />
                <span>Connect GitHub</span>
              </button>
            )}
          </div>

          {/* Search & Actions */}
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden md:block" data-tour="search"><GlobalSearch /></div>
            <div className="md:hidden" data-tour="search"><GlobalSearch compact /></div>

            <ThemeToggle />
            <div data-tour="notifications"><NotificationCenter /></div>

            <Link
              to="/dashboard/settings"
              className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-[#DCD0C3] bg-white text-[#5E4C3E] hover:text-[#362217] transition shadow-xs"
              title="Settings & Credentials"
            >
              <Settings className="h-4 w-4" />
            </Link>
          </div>
        </header>

        <OnboardingTour />

        {/* Dynamic Body */}
        <main className="flex-1 overflow-auto p-6 sm:p-8">
          {/* Keyed by path so each page fades in when you navigate. */}
          <div key={location.pathname} className="page-enter">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
