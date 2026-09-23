import { useState, useEffect } from "react";
import Card from "../components/Card";
import Button from "../components/Button";
import { CheckCircle2, Terminal, RefreshCw, Rocket } from "lucide-react";
import { getProjects } from "../services/api";

export default function Deployments() {
  const [selectedLogs, setSelectedLogs] = useState(null);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadDeployments = async () => {
    setLoading(true);
    try {
      const data = await getProjects();
      if (Array.isArray(data)) {
        setProjects(data);
      }
    } catch {
      setProjects([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDeployments();
  }, []);

  return (
    <div className="flex flex-col gap-6 w-full text-[#362217]">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-[#362217]">Deployments</h2>
          <p className="text-xs text-[#5E4C3E] mt-1">Real-time build pipeline logs and active deployment history</p>
        </div>
        <Button icon={RefreshCw} variant="outline" size="sm" onClick={loadDeployments}>
          Refresh Logs
        </Button>
      </div>

      {/* Deployments List */}
      {loading ? (
        <div className="flex justify-center py-12 text-xs text-[#8C7667]">
          Loading deployment telemetry...
        </div>
      ) : projects.length > 0 ? (
        <div className="flex flex-col gap-4">
          {projects.map((proj) => (
            <Card key={proj.id} hoverable={true} className="flex flex-col gap-4 bg-white border border-[#EAE1D5]">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-[#2E6B4F]/10 border border-[#2E6B4F]/20 text-[#2E6B4F] shrink-0">
                    <CheckCircle2 className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-bold text-[#362217]">{proj.name}</h3>
                      <span className="text-xs font-mono text-[#8C7667]">({proj.id.slice(-8)})</span>
                    </div>
                    <p className="text-xs text-[#5E4C3E] mt-0.5 font-mono">main • Initial deployment import</p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <div className="flex flex-col items-end text-xs">
                    <span className="text-[#2E6B4F] font-semibold">{proj.status || "Imported"}</span>
                    <span className="text-[#8C7667]">Just now</span>
                  </div>
                  <Button 
                    size="sm" 
                    variant="outline" 
                    icon={Terminal}
                    onClick={() => setSelectedLogs(selectedLogs === proj.id ? null : proj.id)}
                  >
                    {selectedLogs === proj.id ? "Hide Logs" : "View Logs"}
                  </Button>
                </div>
              </div>

              {/* Expandable Logs Section */}
              {selectedLogs === proj.id && (
                <div className="mt-2 rounded-xl border border-[#362217] bg-[#362217] p-4 font-mono text-xs text-[#E8C39E]">
                  <div className="text-[#D9A87E] mb-2 border-b border-[#4D3325] pb-2 flex justify-between items-center">
                    <span>Build Telemetry Logs — {proj.name}</span>
                    <span className="text-[#2E6B4F]">Exit Code: 0</span>
                  </div>
                  <div className="flex flex-col gap-1 text-[#F8F4EE]">
                    <div className="leading-relaxed hover:bg-[#4D3325]/40 px-1 py-0.5 rounded">
                      [INIT] Linking repository {proj.repoName || proj.name}...
                    </div>
                    <div className="leading-relaxed hover:bg-[#4D3325]/40 px-1 py-0.5 rounded">
                      [SPEC] Framework auto-detection: {proj.framework || "JavaScript"}
                    </div>
                    <div className="leading-relaxed hover:bg-[#4D3325]/40 px-1 py-0.5 rounded text-[#2E6B4F]">
                      [SUCCESS] Environment parameters provisioned. Status: {proj.status || "Imported"}
                    </div>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      ) : (
        <Card hoverable={false} className="flex flex-col items-center justify-center py-12 text-center bg-white border border-[#EAE1D5]">
          <div className="p-4 rounded-2xl bg-[#F8F4EE] border border-[#EADFCF] mb-3">
            <Rocket className="h-8 w-8 text-[#9E5D2D]" />
          </div>
          <h3 className="text-base font-bold text-[#362217]">No Active Deployments</h3>
          <p className="text-xs text-[#5E4C3E] mt-1 max-w-sm mb-4">
            Import a GitHub repository or create a project to generate deployment pipelines and logs.
          </p>
          <Button size="sm" onClick={() => window.location.href = "http://localhost:5000/api/github/login"}>
            Connect GitHub
          </Button>
        </Card>
      )}
    </div>
  );
}
