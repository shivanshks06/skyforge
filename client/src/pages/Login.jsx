import { useState, useContext } from "react";
import { useNavigate, Link } from "react-router-dom";
import api from "../services/api";
import { AuthContext } from "../context/authContext.js";
import Input from "../components/Input";
import Button from "../components/Button";
import Logo from "../components/Logo";
import { Mail, Lock, AlertCircle, ArrowRight } from "lucide-react";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  
  const { login } = useContext(AuthContext);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.post("/auth/login", { email, password });
      login(res.data.token, res.data.user);
      navigate("/dashboard");
    } catch (err) {
      console.error("Login attempt failed:", err);
      const networkErr = !err.response && (err.code === "ERR_NETWORK" || err.message?.includes("Network"));
      setError(
        err.response?.data?.message ||
        (networkErr ? "Cannot connect to server. Ensure SkyForge backend is running on port 5000." : "Invalid email or password.")
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="app-bg relative flex min-h-screen items-center justify-center bg-[#FAF8F5] p-4 text-[#362217] selection:bg-[#9E5D2D]/20">
      {/* Background Glow Effects */}
      <div className="ambient-glow-teal top-1/4 right-1/3" />
      <div className="ambient-glow-bronze bottom-10 left-10" />
      <div className="absolute inset-0 bg-grid-pattern opacity-60" />

      <div className="relative z-10 w-full max-w-md">
        <div className="glass-card rounded-3xl p-8 sm:p-10 shadow-xl border border-[#EAE1D5] bg-white">
          <div className="mb-8 flex flex-col items-center gap-3 text-center">
            <Logo />
            <h2 className="text-2xl font-bold tracking-tight text-[#362217] mt-2">
              Welcome back
            </h2>
            <p className="text-xs text-[#5E4C3E]">Sign in to manage your cloud deployments</p>
          </div>

          {error && (
            <div className="mb-6 flex items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3.5 text-xs text-red-600">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Input
              label="Email Address"
              type="email"
              placeholder="alex@skyforge.dev"
              icon={Mail}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Input
              label="Password"
              type="password"
              placeholder="••••••••••••"
              icon={Lock}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />

            <Button
              type="submit"
              loading={submitting}
              icon={ArrowRight}
              className="mt-2 w-full py-3"
            >
              Sign In
            </Button>
          </form>

          <div className="mt-8 text-center text-xs text-[#5E4C3E]">
            Don't have an account?{" "}
            <Link to="/signup" className="font-semibold text-[#9E5D2D] hover:underline transition">
              Create one now
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
