import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#050508] text-center text-white">
      <p className="text-sm font-bold uppercase tracking-[0.3em] text-amber-400">404</p>
      <h1 className="text-3xl font-bold">Page not found</h1>
      <Link to="/dashboard" className="rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-500">Return to dashboard</Link>
    </main>
  );
}
