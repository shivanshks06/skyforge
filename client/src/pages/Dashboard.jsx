import { useState, useEffect, useContext, useRef } from "react";
import { useNavigate } from "react-router-dom";
import Card from "../components/Card";
import Button from "../components/Button";
import RepositoryIntelligenceModal from "../components/RepositoryIntelligenceModal";
import {
  FolderGit2,
  Rocket,
  CheckCircle2,
  Cloud,
  Plus,
  GitPullRequest,
  ExternalLink,
  Check,
  Cpu,
  Sparkles,
  RefreshCw
} from "lucide-react";
import { AuthContext } from "../context/authContext.js";
import { getGithubLoginUrl, getGithubRepos, getProjectDeployments, createProject, getProjects, analyzeRepository, getAwsStatus } from "../services/api";
import StatusBadge, { StatusDot } from "../components/StatusBadge";
import { projectState } from "../utils/projectState";
import { startTour } from "../utils/tour";

export default function Dashboard() {
  const { user, isGithubConnected, githubAccount } = useContext(AuthContext);
  const navigate = useNavigate();
  const [repositories, setRepositories] = useState([]);
  const [projects, setProjects] = useState([]);
  const [deploymentCount, setDeploymentCount] = useState(0);
  const [loadingRepos, setLoadingRepos] = useState(true);
  const [analyzingRepo, setAnalyzingRepo] = useState(null);
  const [analysisReport, setAnalysisReport] = useState(null);
  const [isScanning, setIsScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState(null);
  const [aws, setAws] = useState(null);
  const analysisRequestRef = useRef(0);

  const showToast = (message, type = "info") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const handleConnectGitHub = async () => {
    try {
      window.location.assign(await getGithubLoginUrl());
    } catch (error) {
      showToast(error.response?.data?.message || "Unable to start GitHub authorization.", "error");
    }
  };

  const fetchDashboardData = async () => {
    let currentProjects = [];
    getAwsStatus().then(setAws).catch(() => setAws({ connected: false }));
    try {
      const projData = await getProjects();
      if (Array.isArray(projData)) {
        currentProjects = projData;
        setProjects(projData);
        const histories = await Promise.all(projData.map((project) => getProjectDeployments(project.id).catch(() => [])));
        setDeploymentCount(histories.reduce((total, history) => total + history.filter((deployment) => !String(deployment.status || "").startsWith("DESTROY")).length, 0));
      }
    } catch (projErr) {
      console.warn("Failed to fetch projects:", projErr);
      setProjects([]);
    }

    setLoadingRepos(true);
    try {
      const repos = await getGithubRepos();
      if (Array.isArray(repos)) {
        const formatted = repos.map((r) => {
          const repoFullName = (r.fullName || `${r.owner}/${r.name}`).toLowerCase();
          const isImported = currentProjects.some(
            (project) => project.repoName?.trim().toLowerCase() === repoFullName && (project.branch || "main") === (r.defaultBranch || "main")
          );
          return {
            id: r.id,
            name: r.name,
            owner: r.owner || r.fullName?.split("/")[0] || "user",
            fullName: r.fullName || `${r.owner}/${r.name}`,
            defaultBranch: r.defaultBranch || "main",
            language: r.language || "N/A",
            visibility: r.private ? "Private" : "Public",
            updatedAt: r.updatedAt ? `Updated ${new Date(r.updatedAt).toLocaleDateString()}` : "Recently",
            githubUrl: r.htmlUrl || `https://github.com/${r.fullName}`,
            imported: isImported,
          };
        });
        setRepositories(formatted);
      } else {
        setRepositories([]);
      }
    } catch (repoErr) {
      console.error("Failed to fetch repositories:", repoErr.response?.data || repoErr.message);
      setRepositories([]);
    } finally {
      setLoadingRepos(false);
    }
  };

  useEffect(() => {
    const task = window.setTimeout(() => {
      void fetchDashboardData();
    }, 0);
    return () => window.clearTimeout(task);
  }, [isGithubConnected, user?.id]);

  const handleAnalyzeAndImport = async (repo) => {
    const requestId = ++analysisRequestRef.current;
    setAnalyzingRepo(repo);
    setAnalysisReport(null);
    setIsScanning(true);

    try {
      const owner = repo.owner || repo.fullName?.split("/")[0] || "user";
      const report = await analyzeRepository({
        owner,
        repo: repo.name,
        branch: repo.defaultBranch || "main",
      });
      if (requestId !== analysisRequestRef.current) return;
      setAnalysisReport(report);
    } catch (error) {
      if (requestId !== analysisRequestRef.current) return;
      console.error("Repository analysis failed:", error);
      showToast(error.response?.data?.message || "Repository analysis failed.", "error");
      setAnalyzingRepo(null);
    } finally {
      if (requestId === analysisRequestRef.current) setIsScanning(false);
    }
  };

  const handleConfirmImport = async (projectData) => {
    setImporting(true);

    try {
      const newProj = await createProject({
        name: projectData.name,
        repoName: projectData.repoName,
        branch: projectData.branch,
        language: projectData.language,
        framework: projectData.framework,
        packageManager: projectData.packageManager,
        buildTool: projectData.buildTool,
        buildCommand: projectData.buildCommand,
        startCommand: projectData.startCommand,
        port: projectData.port,
        dockerized: projectData.dockerized,
        requiredEnv: projectData.requiredEnv,
        envAnalysis: projectData.envAnalysis,
        deploymentTarget: projectData.deploymentTarget,
        confidence: projectData.confidence,
        githubUrl: projectData.githubUrl,
      });

      setRepositories((prev) =>
        prev.map((r) => {
          const sameRepository = (r.fullName || `${r.owner}/${r.name}`).toLowerCase() === projectData.repoName.toLowerCase();
          const sameBranch = (r.defaultBranch || "main") === (projectData.branch || "main");
          return sameRepository && sameBranch ? { ...r, imported: true } : r;
        })
      );
      setProjects((prev) => [newProj, ...prev]);
      setAnalyzingRepo(null);
      setAnalysisReport(null);
      showToast(`Successfully imported ${projectData.name}! Deployment profile ready.`, "success");
    } catch (error) {
      console.error("Failed to confirm import:", error);
      showToast(error.response?.data?.message || "Import failed; no project was created.", "error");
    } finally {
      setImporting(false);
    }
  };

  const liveProjects = projects.filter((project) => projectState(project) === "live");
  const attention = projects.filter((project) => projectState(project) === "failed");
  const stats = [
    { label: "Projects", value: `${projects.length}`, icon: FolderGit2, color: "text-[#9E5D2D] bg-[#9E5D2D]/10 border-[#9E5D2D]/20", onClick: () => navigate("/dashboard/projects") },
    { label: "Live sites", value: `${liveProjects.length}`, icon: Cloud, color: "text-[#2E6B4F] bg-[#2E6B4F]/10 border-[#2E6B4F]/20", onClick: () => navigate("/dashboard/projects") },
    { label: "Deployments", value: `${deploymentCount}`, icon: Rocket, color: "text-[#2A6668] bg-[#2A6668]/10 border-[#2A6668]/20", onClick: () => navigate("/dashboard/deployments") },
    { label: "Need attention", value: `${attention.length}`, icon: Cpu, color: attention.length ? "text-[#9E2A2B] bg-[#9E2A2B]/10 border-[#9E2A2B]/20" : "text-[#8C7667] bg-[#FAF8F5] border-[#EAE1D5]", onClick: () => navigate(attention[0] ? `/project/${attention[0].id}/deploy` : "/dashboard/projects") },
  ];

  const quickActions = [
    {
      title: "New Project",
      description: "Deploy a new application from your Git repository with automated intelligence.",
      btnText: "Create Project",
      icon: Plus,
      variant: "primary",
      onClick: () => navigate("/dashboard/projects")
    },
    {
      title: isGithubConnected ? "Sync GitHub" : "Connect GitHub",
      description: isGithubConnected
        ? `Connected as @${githubAccount?.username || user?.github?.username || "developer"}. Re-fetch repositories.`
        : "Link repositories for automated CI/CD builds and zero-config deployment.",
      btnText: isGithubConnected ? "Sync Now" : "Link Account",
      icon: isGithubConnected ? RefreshCw : GitPullRequest,
      variant: "secondary",
      onClick: isGithubConnected ? fetchDashboardData : handleConnectGitHub
    },
    {
      title: "View Deployments",
      description: "Monitor live container instances and AWS ECS cluster logs.",
      btnText: "View History",
      icon: ExternalLink,
      variant: "outline",
      onClick: () => navigate("/dashboard/deployments")
    }
  ];

  return (
    <div className="flex flex-col gap-8 w-full">
      {/* Toast Notification */}
      {toast && (
        <div role={toast.type === "error" ? "alert" : "status"} className={`fixed top-6 right-6 z-50 flex items-center gap-2.5 rounded-2xl border bg-white px-5 py-3.5 text-xs font-bold shadow-xl animate-in fade-in slide-in-from-top-4 ${toast.type === "error" ? "border-[#9E2A2B]/30 text-[#9E2A2B] shadow-[#9E2A2B]/10" : "border-[#2E6B4F]/30 text-[#2E6B4F] shadow-[#2E6B4F]/10"}`}>
          {toast.type === "error" ? <RefreshCw className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
          <span>{toast.message}</span>
        </div>
      )}

      {/* Welcome Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-3xl border border-[#4D3325] bg-gradient-to-r from-[#362217] via-[#3D271D] to-[#2C1A10] p-7 text-white shadow-xl">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full bg-[#9E5D2D] text-[10px] font-bold tracking-wider uppercase">
              {liveProjects.length ? `${liveProjects.length} live` : "Ready"}
            </span>
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
            Welcome back, {String(user?.name || "Developer").split(" ")[0].replace(/^./, (letter) => letter.toUpperCase())}
          </h2>
          <p className="text-xs text-[#D8CCC0] max-w-xl leading-relaxed">
            Pick a GitHub repository below and SkyForge works out how to build it, then deploys it to your own AWS account.
          </p>
        </div>

        {/* Dynamic GitHub Action in Welcome Banner */}
        <div className="flex items-center gap-3 self-start sm:self-center">
          {isGithubConnected ? (
            <div className="flex items-center gap-2 bg-white/10 backdrop-blur-md border border-white/20 px-3.5 py-2 rounded-xl text-xs font-semibold text-white">
              <CheckCircle2 className="h-4 w-4 text-[#2E6B4F]" />
              <span>Linked: @{githubAccount?.username || user?.github?.username || "connected"}</span>
              <button
                onClick={fetchDashboardData}
                title="Sync Repositories"
                className="ml-1 p-1 hover:bg-white/20 rounded-lg transition"
              >
                <RefreshCw className="h-3.5 w-3.5 text-[#D8CCC0]" />
              </button>
            </div>
          ) : (
            <Button
              icon={GitPullRequest}
              size="sm"
              onClick={handleConnectGitHub}
            >
              Connect GitHub
            </Button>
          )}
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        {stats.map((stat, idx) => (
          <Card key={idx} glow={false} role="button" tabIndex={0} onClick={stat.onClick} onKeyDown={(event) => event.key === "Enter" && stat.onClick()} className="lift cursor-pointer flex items-center justify-between bg-white border border-[#EAE1D5]">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-[#5E4C3E]">{stat.label}</span>
              <span className="text-2xl font-bold text-[#362217] tracking-tight">{stat.value}</span>
            </div>
            <div className={`p-3 rounded-2xl border ${stat.color}`}>
              <stat.icon className="h-5 w-5" />
            </div>
          </Card>
        ))}
      </div>

      {(() => {
        const steps = [
          { label: "Connect your AWS account", done: Boolean(aws?.connected), action: () => navigate("/dashboard/settings"), cta: "Connect" },
          { label: "Connect GitHub", done: Boolean(isGithubConnected), action: handleConnectGitHub, cta: "Connect" },
          { label: "Import a repository", done: projects.length > 0, action: () => navigate("/dashboard/new"), cta: "Choose one" },
          { label: "Deploy your first site", done: projects.some((project) => project.latestDeployment), action: () => navigate("/dashboard/new"), cta: "Deploy" },
        ];
        const done = steps.filter((step) => step.done).length;
        if (done === steps.length) return null;
        return (
          <Card glow={false} className="bg-white border border-[#EAE1D5] flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-bold text-[#362217]">Getting started</h3>
                <p className="text-xs text-[#5E4C3E]">{done} of {steps.length} done. Each step takes a minute or two. New to AWS? Read the <button type="button" onClick={() => navigate("/dashboard/aws-guide")} className="font-semibold text-[#9E5D2D] hover:underline">AWS guide</button>, or <button type="button" onClick={startTour} className="font-semibold text-[#9E5D2D] hover:underline">take a 30-second tour</button>.</p>
              </div>
              <div className="h-2 w-40 overflow-hidden rounded-full bg-[#F0E7DC]"><div className="h-full rounded-full bg-[#9E5D2D] transition-all duration-500" style={{ width: `${(done / steps.length) * 100}%` }} /></div>
            </div>
            <ol className="grid grid-cols-1 md:grid-cols-4 gap-3">
              {steps.map((step, index) => (
                <li key={step.label} className={`flex flex-col gap-2 rounded-2xl border p-3 ${step.done ? "border-[#2E6B4F]/25 bg-[#2E6B4F]/5" : "border-[#EADFCF] bg-[#FFFBF6]"}`}>
                  <span className="flex items-center gap-2 text-xs font-bold text-[#362217]">
                    {step.done ? <CheckCircle2 className="h-4 w-4 text-[#2E6B4F]" /> : <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#9E5D2D] text-[10px] text-white">{index + 1}</span>}
                    {step.label}
                  </span>
                  {!step.done && <button type="button" onClick={step.action} className="self-start rounded-lg bg-[#9E5D2D] px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-[#8A5026]">{step.cta}</button>}
                </li>
              ))}
            </ol>
          </Card>
        );
      })()}

      {liveProjects.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="text-lg font-bold text-[#362217]">Your live sites</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {liveProjects.map((project) => (
              <Card key={project.id} glow={false} className="lift bg-white border border-[#EAE1D5] flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 font-bold text-[#362217] truncate"><StatusDot state="live" /> {project.name}</span>
                  <StatusBadge state="live" size="xs" />
                </div>
                {project.latestDeployment?.liveUrl && (
                  <a href={project.latestDeployment.liveUrl} target="_blank" rel="noreferrer" className="truncate font-mono text-[11px] text-[#9E5D2D] hover:underline">{project.latestDeployment.liveUrl.replace(/^https?:\/\//, "")}</a>
                )}
                <div className="flex gap-2">
                  {project.latestDeployment?.liveUrl && <a href={project.latestDeployment.liveUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg bg-[#9E5D2D] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#8A5026]"><ExternalLink className="h-3.5 w-3.5" /> Open site</a>}
                  <button type="button" onClick={() => navigate(`/project/${project.id}/deploy`)} className="rounded-lg border border-[#DCD0C3] px-3 py-1.5 text-xs font-semibold text-[#5E4C3E] transition hover:bg-[#FAF6F0]">Console</button>
                  <button type="button" onClick={() => navigate(`/project/${project.id}/security`)} className="rounded-lg border border-[#DCD0C3] px-3 py-1.5 text-xs font-semibold text-[#5E4C3E] transition hover:bg-[#FAF6F0]">Security</button>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* GitHub Repositories & Intelligence Scanner Section */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="text-lg font-bold text-[#362217] flex items-center gap-2">
              <Cpu className="h-5 w-5 text-[#9E5D2D]" />
              <span id="import-repositories" className="scroll-mt-24">Import a repository</span>
            </h3>
            <p className="text-xs text-[#5E4C3E] mt-0.5">
              Your GitHub repositories. SkyForge detects the framework, commands, port and settings each one needs.
            </p>
          </div>

          {/* Connected state button */}
          {isGithubConnected ? (
            <Button
              variant="outline"
              size="sm"
              icon={RefreshCw}
              onClick={fetchDashboardData}
            >
              Sync Repositories
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              icon={GitPullRequest}
              onClick={handleConnectGitHub}
            >
              Connect GitHub
            </Button>
          )}
        </div>

        {loadingRepos ? (
          <div className="flex flex-col items-center justify-center py-16 text-center gap-2 bg-white rounded-2xl border border-[#EAE1D5]">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-[#9E5D2D] border-t-transparent" />
            <span className="text-xs font-medium text-[#8C7667]">Scanning connected repositories...</span>
          </div>
        ) : repositories.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {repositories.map((repo) => (
              <Card key={repo.id} glow={false} className="flex flex-col justify-between gap-5 bg-white border border-[#EAE1D5]">
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <h4 className="font-bold text-[#362217] text-base truncate">{repo.name}</h4>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-[#F8F4EE] text-[#8C7667] border border-[#EAE1D5]">
                      {repo.visibility}
                    </span>
                  </div>
                  <p className="text-xs text-[#5E4C3E] flex items-center gap-2 font-medium">
                    <span className="font-semibold">{repo.language}</span>
                    <span>•</span>
                    <span className="text-[#8C7667]">{repo.defaultBranch}</span>
                  </p>
                  <p className="text-[11px] text-[#8C7667]">{repo.updatedAt}</p>
                </div>

                {repo.imported ? (
                  <Button
                    disabled
                    size="sm"
                    className="w-full bg-[#2E6B4F]/10 text-[#2E6B4F] border border-[#2E6B4F]/30 cursor-default"
                    icon={Check}
                  >
                    Imported
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    className="w-full"
                    icon={Sparkles}
                    onClick={() => handleAnalyzeAndImport(repo)}
                  >
                    Analyze & Import
                  </Button>
                )}
              </Card>
            ))}
          </div>
        ) : (
          <Card hoverable={false} className="flex flex-col items-center justify-center py-12 text-center bg-white border border-[#EAE1D5]">
            <div className="p-4 rounded-2xl bg-[#F8F4EE] border border-[#EADFCF] mb-3">
              <GitPullRequest className="h-7 w-7 text-[#9E5D2D]" />
            </div>
            <h4 className="font-bold text-base text-[#362217]">
              {isGithubConnected ? "No Repositories Found" : "No Repositories Connected"}
            </h4>
            <p className="text-xs text-[#5E4C3E] mt-1 max-w-sm mb-4 leading-relaxed">
              {isGithubConnected
                ? "Your GitHub account is connected. Click sync to refresh repositories or create a repository on GitHub."
                : "Connect your GitHub account to automatically scan, inspect, and analyze all your repositories with the SkyForge Intelligence Engine."}
            </p>
            {isGithubConnected ? (
              <Button size="sm" icon={RefreshCw} onClick={fetchDashboardData}>
                Sync Repositories
              </Button>
            ) : (
              <Button
                size="sm"
                icon={GitPullRequest}
                onClick={handleConnectGitHub}
              >
                Connect GitHub Account
              </Button>
            )}
          </Card>
        )}
      </div>

      {/* Intelligence Modal */}
      <RepositoryIntelligenceModal
        isOpen={Boolean(analyzingRepo)}
        onClose={() => {
          analysisRequestRef.current += 1;
          setAnalyzingRepo(null);
          setAnalysisReport(null);
          setIsScanning(false);
        }}
        repo={analyzingRepo}
        analysisReport={analysisReport}
        isScanning={isScanning}
        onConfirmImport={handleConfirmImport}
        importing={importing}
      />

      {/* Quick Actions */}
      <div>
        <h3 className="text-lg font-bold text-[#362217] mb-4 flex items-center gap-2">
          <span>Quick Actions</span>
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {quickActions.map((action, idx) => (
            <Card key={idx} glow={false} className="flex flex-col justify-between gap-6 bg-white border border-[#EAE1D5]">
              <div className="flex flex-col gap-3">
                <div className="p-3 bg-[#F8F4EE] rounded-2xl w-fit border border-[#EAE1D5]">
                  <action.icon className="h-5 w-5 text-[#9E5D2D]" />
                </div>
                <h4 className="font-semibold text-[#362217] text-base">{action.title}</h4>
                <p className="text-xs text-[#5E4C3E] leading-relaxed">{action.description}</p>
              </div>
              <Button
                variant={action.variant}
                size="sm"
                className="w-full"
                onClick={action.onClick}
              >
                {action.btnText}
              </Button>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
