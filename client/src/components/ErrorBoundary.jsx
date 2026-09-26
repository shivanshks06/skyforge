import { Component } from "react";

export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Unhandled UI error:", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#050508] p-6 text-center text-white">
        <h1 className="text-2xl font-bold">Something went wrong</h1>
        <p className="max-w-md text-sm text-zinc-400">The page encountered an unexpected display issue.</p>
        {this.state.error?.message && (
          <pre className="max-w-xl text-left bg-zinc-900 border border-zinc-800 text-rose-400 p-3 rounded-xl text-xs font-mono overflow-auto max-h-40">
            {this.state.error.message}
          </pre>
        )}
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => window.location.reload()} className="rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold hover:bg-amber-500 cursor-pointer">Reload Page</button>
          <button type="button" onClick={() => { this.setState({ error: null }); window.location.assign("/dashboard"); }} className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-semibold text-zinc-200 hover:bg-zinc-700 cursor-pointer">Back to Dashboard</button>
        </div>
      </main>
    );
  }
}
