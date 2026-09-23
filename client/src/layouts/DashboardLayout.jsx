import { Outlet, Link, useLocation, useNavigate } from "react-router-dom";
import { useContext } from "react";
import { AuthContext } from "../context/AuthContext";
import Logo from "../components/Logo";
import { 
  LayoutDashboard, 
  FolderGit2, 
  Rocket, 
  Settings, 
  LogOut, 
  Search, 
  Bell, 
  ShieldCheck 
} from "lucide-react";

export default function DashboardLayout() {
  const { logout, user } = useContext(AuthContext);
  const location = useLocation();
  const navigate = useNavigate();

  const navItems = [
    { label: "Overview", path: "/dashboard", icon: LayoutDashboard },
    { label: "Projects", path: "/dashboard/projects", icon: FolderGit2 },
    { label: "Deployments", path: "/dashboard/deployments", icon: Rocket },
    { label: "Settings", path: "/dashboard/settings", icon: Settings },
  ];

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <div className="flex h-screen bg-[#FAF8F5] text-[#362217] selection:bg-[#9E5D2D]/20">
      {/* Sidebar */}
      <aside className="w-64 flex-shrink-0 border-r border-[#2A1910] bg-[#362217] text-white flex flex-col justify-between">
        <div>
          <div className="p-6 border-b border-[#4D3325]">
            <Logo />
          </div>

          <nav className="p-4 flex flex-col gap-1.5">
            {navItems.map((item) => {
              const isActive = location.pathname === item.path;
              return (
                <Link
                  key={item.path}
                  to={item.path}
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
        <header className="h-20 border-b border-[#EADFCF] bg-[#FAF8F5]/90 backdrop-blur-xl flex items-center justify-between px-8">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-[#362217]">Dashboard</h1>
            <div className="hidden sm:flex items-center gap-1.5 rounded-full border border-[#2E6B4F]/30 bg-[#2E6B4F]/10 px-3 py-1 text-xs text-[#2E6B4F] font-semibold">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>AWS • Connected</span>
            </div>
          </div>

          {/* Search & Actions */}
          <div className="flex items-center gap-4">
            <div className="relative hidden md:flex items-center">
              <Search className="absolute left-3 h-4 w-4 text-[#8C7667]" />
              <input
                type="text"
                placeholder="Search projects or deployments..."
                className="w-64 rounded-xl border border-[#DCD0C3] bg-white pl-9 pr-4 py-2 text-xs text-[#362217] placeholder-[#A39284] outline-none focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D]"
              />
            </div>

            <button className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-[#DCD0C3] bg-white text-[#5E4C3E] hover:text-[#362217] transition shadow-sm">
              <Bell className="h-4 w-4" />
              <span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-[#9E5D2D]" />
            </button>
          </div>
        </header>

        {/* Dynamic Body */}
        <main className="flex-1 overflow-auto p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
