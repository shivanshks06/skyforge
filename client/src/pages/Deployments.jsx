import { useContext, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Card from "../components/Card";
import Button from "../components/Button";
import { AlertCircle, CheckCircle2, Clock3, FolderGit2, GitPullRequest, RefreshCw, Rocket, Terminal } from "lucide-react";
import { AuthContext } from "../context/authContext.js";
import { getDeploymentById, getGithubLoginUrl, getProjectDeployments, getProjects } from "../services/api";

function statusTone(status) {
  if (["LIVE", "ROLLED_BACK"].includes(status)) return "bg-[#2E6B4F]/10 border-[#2E6B4F]/20 text-[#2E6B4F]";
  if (["FAILED", "DESTROY_FAILED", "CANCELLED"].includes(status)) return "bg-[#9E2A2B]/10 border-[#9E2A2B]/20 text-[#9E2A2B]";
  if (["DESTROYING", "ROLLING_BACK"].includes(status)) return "bg-[#6D28D9]/10 border-[#6D28D9]/20 text-[#6D28D9]";
  return "bg-[#D97706]/10 border-[#D97706]/20 text-[#D97706]";
}

export default function Deployments() {
  const navigate = useNavigate();
  const { isGithubConnected } = useContext(AuthContext);
  const [deployments, setDeployments] = useState([]);
  const [selectedLogs, setSelectedLogs] = useState(null);
  const [logsByDeployment, setLogsByDeployment] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadDeployments = async () => {
    setLoading(true);
    setError("");
    try {
      const projects = await getProjects();
      const results = await Promise.allSettled(projects.map(async (project) => {
        const records = await getProjectDeployments(project.id);
        return records.map((deployment) => ({ ...deployment, project }));
      }));
      const fulfilledResults = results.filter((result) => result.status === "fulfilled");
      const history = fulfilledResults.flatMap((result) => result.value);
      const failedCount = results.length - fulfilledResults.length;
      if (failedCount) setError(`${failedCount} project deployment history request${failedCount === 1 ? "" : "s"} could not be loaded.`);
      setDeployments(history.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
    } catch (loadError) {
      setError(loadError.response?.data?.message || "Unable to load deployment history.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const task = window.setTimeout(() => void loadDeployments(), 0);
    return () => window.clearTimeout(task);
  }, []);

  const handleConnectGitHub = async () => {
    try {
      window.location.assign(await getGithubLoginUrl());
    } catch (connectError) {
      setError(connectError.response?.data?.message || "Unable to start GitHub authorization.");
    }
  };

  const toggleLogs = async (deployment) => {
    if (selectedLogs === deployment.id) {
      setSelectedLogs(null);
      return;
    }
    setSelectedLogs(deployment.id);
    if (!logsByDeployment[deployment.id]) {
      try {
        const result = await getDeploymentById(deployment.id);
        setLogsByDeployment((current) => ({ ...current, [deployment.id]: result.logs || result.deployment?.logs || [] }));
      } catch (logError) {
        setLogsByDeployment((current) => ({ ...current, [deployment.id]: [{ message: logError.response?.data?.message || "Logs unavailable", level: "error" }] }));
      }
    }
  };

  const statusIcon = (status) => status === "LIVE" || status === "ROLLED_BACK"
    ? <CheckCircle2 className="h-5 w-5" />
    : ["FAILED", "DESTROY_FAILED", "CANCELLED"].includes(status)
      ? <AlertCircle className="h-5 w-5" />
      : <Clock3 className="h-5 w-5" />;

  return (
    <div className="flex flex-col gap-6 w-full text-[#362217]">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-[#362217]">Deployments</h2>
          <p className="text-xs text-[#5E4C3E] mt-1">Verified build, rollout, and health history</p>
        </div>
        <Button icon={RefreshCw} variant="outline" size="sm" onClick={loadDeployments}>Refresh</Button>
      </div>

      {error && <div className="rounded-xl border border-[#9E2A2B]/30 bg-[#9E2A2B]/10 px-4 py-3 text-xs text-[#7E2223]">{error}</div>}

      {loading ? (
        <div className="flex justify-center items-center py-16 text-xs text-[#8C7667] gap-2">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#9E5D2D] border-t-transparent" />
          <span>Loading deployment history...</span>
        </div>
      ) : deployments.length > 0 ? (
        <div className="flex flex-col gap-4">
          {deployments.map((deployment) => {
            const logs = logsByDeployment[deployment.id] || deployment.logs || [];
            return (
              <Card key={deployment.id} hoverable={false} className="flex flex-col gap-4 bg-white border border-[#EAE1D5]">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <div className={`p-3 rounded-xl border shrink-0 ${statusTone(deployment.status)}`}>
                      {statusIcon(deployment.status)}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-bold text-[#362217]">{deployment.project?.name || "Project"}</h3>
                        <span className="text-xs font-mono text-[#8C7667]">({deployment.id.slice(-8)})</span>
                      </div>
                      <p className="text-xs text-[#5E4C3E] mt-0.5 font-mono">
                        {deployment.project?.branch || "main"} • {deployment.target || deployment.project?.deploymentTarget || "AWS"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-semibold text-[#5E4C3E]">{deployment.status}</span>
                    <Button size="sm" variant="outline" icon={Terminal} onClick={() => toggleLogs(deployment)}>
                      {selectedLogs === deployment.id ? "Hide Logs" : "View Logs"}
                    </Button>
                    <Button size="sm" icon={Rocket} onClick={() => navigate(`/project/${deployment.projectId}/deploy?deploymentId=${encodeURIComponent(deployment.id)}`)} className="bg-[#9E5D2D] hover:bg-[#844C22] text-white">
                      Console
                    </Button>
                  </div>
                </div>

                {selectedLogs === deployment.id && (
                  <div className="mt-2 rounded-xl border border-[#362217] bg-[#362217] p-4 font-mono text-xs text-[#E8C39E] max-h-80 overflow-auto">
                    {logs.length ? logs.map((log, index) => (
                      <div key={log.id || index} className="leading-relaxed hover:bg-[#4D3325]/40 px-1 py-0.5 rounded">
                        <span className="text-[#D9A87E]">[{log.stage || "PIPELINE"}]</span> {log.message}
                      </div>
                    )) : <div className="text-[#8C7667]">No persisted logs are available for this deployment.</div>}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      ) : (
        <Card hoverable={false} className="flex flex-col items-center justify-center py-12 text-center bg-white border border-[#EAE1D5]">
          <div className="p-4 rounded-2xl bg-[#F8F4EE] border border-[#EADFCF] mb-3"><Rocket className="h-8 w-8 text-[#9E5D2D]" /></div>
          <h3 className="text-base font-bold text-[#362217]">No Deployments Yet</h3>
          <p className="text-xs text-[#5E4C3E] mt-1 max-w-sm mb-4">Import a repository and run a deployment to see verified build and rollout history here.</p>
          {isGithubConnected ? (
            <Button size="sm" icon={FolderGit2} onClick={() => navigate("/dashboard")}>Import from Dashboard</Button>
          ) : (
            <Button size="sm" icon={GitPullRequest} onClick={handleConnectGitHub}>Connect GitHub</Button>
          )}
        </Card>
      )}
    </div>
  );
}
