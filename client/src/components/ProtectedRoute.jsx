import { useContext } from "react";
import { Navigate } from "react-router-dom";
import { AuthContext } from "../context/authContext.js";
import { Loader2 } from "lucide-react";

export default function ProtectedRoute({ children }) {
  const { user, loading } = useContext(AuthContext);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050508]">
        <div className="flex flex-col items-center gap-3">
          <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl bg-purple-500/10 border border-purple-500/30 shadow-lg shadow-purple-500/20">
            <Loader2 className="h-6 w-6 animate-spin text-purple-400" />
          </div>
          <span className="text-xs font-medium text-zinc-500 tracking-wider uppercase">Loading SkyForge...</span>
        </div>
      </div>
    );
  }

  return user ? children : <Navigate to="/login" replace />;
}