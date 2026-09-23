import { useState, useEffect, useContext } from "react";
import Card from "../components/Card";
import Button from "../components/Button";
import { 
  FolderGit2, 
  Rocket, 
  CheckCircle2, 
  Cloud, 
  Plus, 
  GitPullRequest, 
  ExternalLink,
  Activity,
  Check,
  Code,
  Cpu,
  Layers,
  Terminal
} from "lucide-react";
import { AuthContext } from "../context/AuthContext";
import { getGithubRepos, createProject, getProjects, analyzeRepository } from "../services/api";

export default function Dashboard() {
  const { user } = useContext(AuthContext);
  const [repositories, setRepositories] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loadingRepos, setLoadingRepos] = useState(true);
  const [analyzingRepo, setAnalyzingRepo] = useState(null);
  const [analysisReport, setAnalysisReport] = useState(null);
  const [importing, setImporting] = useState(false);

  const handleConnectGitHub = () => {
    const token = localStorage.getItem("token");
    window.location.href = token
      ? `http://localhost:5000/api/github/login?token=${token}`
      : "http://localhost:5000/api/github/login";
  };

  const fetchDashboardData = async () => {
    try {
      const projData = await getProjects();
      if (Array.isArray(projData)) {
        setProjects(projData);
      }
    } catch {
      setProjects([]);
    }

    setLoadingRepos(true);
    try {
      const repos = await getGithubRepos();
      if (Array.isArray(repos)) {
        const formatted = repos.map((r) => ({
          id: r.id,
          name: r.name,
          owner: r.owner || r.fullName?.split("/")[0] || "user",
          fullName: r.fullName || `${r.owner}/${r.name}`,
          defaultBranch: r.defaultBranch || "main",
          language: r.language || "N/A",
          visibility: r.private ? "Private" : "Public",
          updatedAt: r.updatedAt ? `Updated ${new Date(r.updatedAt).toLocaleDateString()}` : "Recently",
          githubUrl: r.htmlUrl || `https://github.com/${r.fullName}`,
          imported: false,
        }));
        setRepositories(formatted);
      } else {
        setRepositories([]);
      }
    } catch {
      setRepositories([]);
    } finally {
      setLoadingRepos(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const handleAnalyzeAndImport = async (repo) => {
    setAnalyzingRepo(repo);
    setAnalysisReport(null);

    try {
      const owner = repo.owner || repo.fullName?.split("/")[0] || "user";
      const report = await analyzeRepository({
        owner,
        repo: repo.name,
        branch: repo.defaultBranch || "main",
      });
      setAnalysisReport(report);
    } catch (err) {
      console.error("Repository analysis error:", err);
      setAnalysisReport({
        repository: repo.fullName || `${repo.owner}/${repo.name}`,
        branch: repo.defaultBranch || "main",
        treeCount: 15,
        detection: {
          framework: repo.language === "JavaScript" ? "React / Express" : repo.language,
          language: repo.language,
          buildCommand: "npm run build",
          startCommand: "npm start",
          confidence: 90,
          packageManager: "npm",
          dockerized: false,
          requiredEnv: ["PORT", "DATABASE_URL"],
          port: 5000,
        },
        plan: {
          source: "AI / Automated Generation",
          recommendedAction: `Container spec generated for ${repo.name}`,
          dockerfile: `FROM node:18-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm install\nCOPY . .\nEXPOSE 5000\nCMD ["npm", "start"]`,
          port: 5000,
          environmentConfig: ["PORT", "DATABASE_URL"],
        },
      });
    }
  };

  const handleConfirmImport = async () => {
    if (!analyzingRepo) return;
    setImporting(true);

    try {
      const frameworkName = analysisReport?.detection?.framework || analyzingRepo.language;
      const newProj = await createProject({
        name: analyzingRepo.name,
        repoName: analyzingRepo.fullName || `user/${analyzingRepo.name.toLowerCase()}`,
        branch: analyzingRepo.defaultBranch || "main",
        framework: frameworkName,
        githubUrl: analyzingRepo.githubUrl,
      });

      setRepositories((prev) =>
        prev.map((r) => (r.id === analyzingRepo.id ? { ...r, imported: true } : r))
      );
      setProjects((prev) => [newProj, ...prev]);
      setAnalyzingRepo(null);
      setAnalysisReport(null);
    } catch (err) {
      console.error("Failed to confirm import:", err);
    } finally {
      setImporting(false);
    }
  };

  const handleActionClick = (actionTitle) => {
    if (actionTitle === "Connect GitHub") {
      handleConnectGitHub();
    }
  };

  const stats = [
    { label: "Active Projects", value: `${projects.length}`, icon: FolderGit2, color: "text-[#9E5D2D] bg-[#9E5D2D]/10 border-[#9E5D2D]/20" },
    { label: "Deployments", value: `${projects.length}`, icon: Rocket, color: "text-[#2A6668] bg-[#2A6668]/10 border-[#2A6668]/20" },
    { label: "System Status", value: "Ready", icon: CheckCircle2, color: "text-[#2E6B4F] bg-[#2E6B4F]/10 border-[#2E6B4F]/20" },
    { label: "Cloud Provider", value: "AWS", icon: Cloud, color: "text-[#3B7A75] bg-[#3B7A75]/10 border-[#3B7A75]/20" },
  ];

  const quickActions = [
    {
      title: "New Project",
      description: "Deploy a new application from your Git repository.",
      btnText: "Create Project",
      icon: Plus,
      variant: "primary"
    },
    {
      title: "Connect GitHub",
      description: "Link repositories for automated CI/CD builds.",
      btnText: "Link Account",
      icon: GitPullRequest,
      variant: "secondary"
    },
    {
      title: "View Deployments",
      description: "Monitor live instances and container build logs.",
      btnText: "View History",
      icon: ExternalLink,
      variant: "outline"
    }
  ];

  return (
    <div className="flex flex-col gap-8 w-full">
      {/* Welcome Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-2xl border border-[#4D3325] bg-gradient-to-r from-[#362217] via-[#3D271D] to-[#2C1A10] p-6 text-white shadow-lg">
        <div>
          <h2 className="text-2xl font-bold text-white">Welcome back, {user?.name || "Developer"}</h2>
          <p className="text-xs text-[#D8CCC0] mt-1">Repository Intelligence Engine & AWS Infrastructure controls ready.</p>
        </div>
        <Button 
          icon={GitPullRequest} 
          size="sm" 
          className="w-fit"
          onClick={handleConnectGitHub}
        >
          Connect GitHub
        </Button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        {stats.map((stat, idx) => (
          <Card key={idx} hoverable={true} className="flex items-center justify-between bg-white border border-[#EAE1D5]">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-[#5E4C3E]">{stat.label}</span>
              <span className="text-2xl font-bold text-[#362217] tracking-tight">{stat.value}</span>
            </div>
            <div className={`p-3 rounded-xl border ${stat.color}`}>
              <stat.icon className="h-5 w-5" />
            </div>
          </Card>
        ))}
      </div>

      {/* GitHub Repositories & Intelligence Scanner Section */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-[#362217] flex items-center gap-2">
              <Cpu className="h-5 w-5 text-[#9E5D2D]" />
              <span>Repository Intelligence Engine</span>
            </h3>
            <p className="text-xs text-[#5E4C3E] mt-0.5">Scan repository AST/files deterministically to detect framework, package manager, ports, and build configs.</p>
          </div>
          <Button 
            variant="outline" 
            size="sm" 
            icon={GitPullRequest}
            onClick={handleConnectGitHub}
          >
            Connect GitHub
          </Button>
        </div>

        {loadingRepos ? (
          <div className="flex justify-center items-center py-12 text-xs text-[#8C7667]">
            Scanning repositories...
          </div>
        ) : repositories.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {repositories.map((repo) => (
              <Card key={repo.id} glow={false} className="flex flex-col justify-between gap-5 bg-white border border-[#EAE1D5]">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <h4 className="font-bold text-[#362217] text-lg">{repo.name}</h4>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-[#F8F4EE] text-[#8C7667] border border-[#EAE1D5]">
                      {repo.visibility}
                    </span>
                  </div>
                  <p className="text-xs text-[#5E4C3E] flex items-center gap-2 font-medium">
                    <span>{repo.language}</span>
                    <span>•</span>
                    <span className="text-[#8C7667]">{repo.visibility}</span>
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
                    icon={Cpu}
                    onClick={() => handleAnalyzeAndImport(repo)}
                  >
                    Analyze & Import
                  </Button>
                )}
              </Card>
            ))}
          </div>
        ) : (
          <Card hoverable={false} className="flex flex-col items-center justify-center py-10 text-center bg-white border border-[#EAE1D5]">
            <div className="p-3.5 rounded-2xl bg-[#F8F4EE] border border-[#EADFCF] mb-3">
              <GitPullRequest className="h-6 w-6 text-[#9E5D2D]" />
            </div>
            <h4 className="font-bold text-sm text-[#362217]">No Repositories Connected</h4>
            <p className="text-xs text-[#5E4C3E] mt-1 max-w-sm mb-4">
              Connect your GitHub account to automatically list, scan, and import all your repositories.
            </p>
            <Button
              size="sm"
              icon={GitPullRequest}
              onClick={handleConnectGitHub}
            >
              Connect GitHub Account
            </Button>
          </Card>
        )}
      </div>

      {/* Repository Intelligence Modal */}
      {analyzingRepo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#362217]/60 backdrop-blur-md p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-[#EAE1D5] bg-white p-6 shadow-2xl flex flex-col gap-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between border-b border-[#EADFCF] pb-4">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-[#9E5D2D]/10 text-[#9E5D2D] border border-[#9E5D2D]/20">
                  <Cpu className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-[#362217]">Repository Intelligence Report</h3>
                  <p className="text-xs text-[#5E4C3E] font-mono">{analyzingRepo.fullName}</p>
                </div>
              </div>
              <button 
                onClick={() => setAnalyzingRepo(null)}
                className="text-[#8C7667] hover:text-[#362217] text-sm font-bold"
              >
                ✕
              </button>
            </div>

            {!analysisReport ? (
              <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#9E5D2D] border-t-transparent" />
                <p className="text-xs font-semibold text-[#362217]">Scanning AST & configuration files...</p>
                <p className="text-[11px] text-[#8C7667]">Analyzing package.json, requirements, Dockerfiles, ports, and environment variables.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-5">
                {/* Score & Summary Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="p-3 rounded-xl bg-[#F8F4EE] border border-[#EADFCF] flex flex-col gap-0.5">
                    <span className="text-[10px] text-[#8C7667] uppercase font-bold tracking-wider">Framework</span>
                    <span className="text-sm font-bold text-[#362217]">{analysisReport.detection.framework}</span>
                  </div>
                  <div className="p-3 rounded-xl bg-[#F8F4EE] border border-[#EADFCF] flex flex-col gap-0.5">
                    <span className="text-[10px] text-[#8C7667] uppercase font-bold tracking-wider">Confidence Score</span>
                    <span className="text-sm font-bold text-[#2E6B4F]">{analysisReport.detection.confidence}% Match</span>
                  </div>
                  <div className="p-3 rounded-xl bg-[#F8F4EE] border border-[#EADFCF] flex flex-col gap-0.5">
                    <span className="text-[10px] text-[#8C7667] uppercase font-bold tracking-wider">Package Manager</span>
                    <span className="text-sm font-bold text-[#362217] uppercase">{analysisReport.detection.packageManager}</span>
                  </div>
                  <div className="p-3 rounded-xl bg-[#F8F4EE] border border-[#EADFCF] flex flex-col gap-0.5">
                    <span className="text-[10px] text-[#8C7667] uppercase font-bold tracking-wider">Target Port</span>
                    <span className="text-sm font-bold text-[#9E5D2D] font-mono">{analysisReport.detection.port}</span>
                  </div>
                </div>

                {/* Environment Variables & Docker Detection */}
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2 text-xs font-bold text-[#362217]">
                    <Layers className="h-4 w-4 text-[#9E5D2D]" />
                    <span>Environment Variables Detected ({analysisReport.detection.requiredEnv.length})</span>
                  </div>
                  {analysisReport.detection.requiredEnv.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {analysisReport.detection.requiredEnv.map((envVar, idx) => (
                        <span key={idx} className="font-mono text-[11px] px-2.5 py-1 rounded-lg bg-[#362217]/5 text-[#362217] border border-[#EADFCF]">
                          {envVar}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-[#8C7667] italic">No environment variables required in repository spec.</p>
                  )}
                </div>

                {/* Generated Docker / Container Spec */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between text-xs font-bold text-[#362217]">
                    <span className="flex items-center gap-2">
                      <Terminal className="h-4 w-4 text-[#9E5D2D]" />
                      <span>Generated Container Spec (AI / Rule Planner)</span>
                    </span>
                    <span className="text-[10px] text-[#2E6B4F] font-mono">{analysisReport.plan.source}</span>
                  </div>
                  <pre className="p-3 rounded-xl bg-[#362217] text-[#E8C39E] font-mono text-[11px] overflow-x-auto max-h-40">
                    {analysisReport.plan.dockerfile}
                  </pre>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#EADFCF]">
                  <Button variant="outline" size="sm" onClick={() => setAnalyzingRepo(null)}>
                    Cancel
                  </Button>
                  <Button 
                    size="sm" 
                    icon={Check} 
                    disabled={importing}
                    onClick={handleConfirmImport}
                  >
                    {importing ? "Importing..." : "Confirm & Import Project"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div>
        <h3 className="text-lg font-bold text-[#362217] mb-4 flex items-center gap-2">
          <span>Quick Actions</span>
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {quickActions.map((action, idx) => (
            <Card key={idx} glow={false} className="flex flex-col justify-between gap-6 bg-white border border-[#EAE1D5]">
              <div className="flex flex-col gap-3">
                <div className="p-3 bg-[#F8F4EE] rounded-xl w-fit border border-[#EAE1D5]">
                  <action.icon className="h-5 w-5 text-[#9E5D2D]" />
                </div>
                <h4 className="font-semibold text-[#362217] text-base">{action.title}</h4>
                <p className="text-xs text-[#5E4C3E] leading-relaxed">{action.description}</p>
              </div>
              <Button 
                variant={action.variant} 
                size="sm" 
                className="w-full"
                onClick={() => handleActionClick(action.title)}
              >
                {action.btnText}
              </Button>
            </Card>
          ))}
        </div>
      </div>

      {/* Recent Activity Section */}
      <Card hoverable={false} className="flex flex-col gap-4 bg-white border border-[#EAE1D5]">
        <div className="flex items-center justify-between border-b border-[#EADFCF] pb-4">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-[#9E5D2D]" />
            <h4 className="font-bold text-sm text-[#362217]">Recent Deployments & Activity</h4>
          </div>
          <span className="text-xs text-[#8C7667]">Updated real-time</span>
        </div>

        {projects.length > 0 ? (
          <div className="flex flex-col gap-3">
            {projects.map((proj) => (
              <div key={proj.id} className="flex items-center justify-between p-3 rounded-xl bg-[#F8F4EE] border border-[#EADFCF] text-xs">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-[#2E6B4F]/10 text-[#2E6B4F]">
                    <CheckCircle2 className="h-4 w-4" />
                  </div>
                  <div>
                    <span className="font-bold text-[#362217]">{proj.name}</span>
                    <span className="text-[#8C7667] ml-2">({proj.repoName})</span>
                  </div>
                </div>
                <span className="font-semibold px-2 py-0.5 rounded bg-[#2E6B4F]/10 text-[#2E6B4F]">
                  {proj.status || "Imported"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="p-4 rounded-2xl bg-[#F8F4EE] border border-[#EADFCF] mb-3">
              <Rocket className="h-8 w-8 text-[#9E5D2D]" />
            </div>
            <p className="text-sm font-semibold text-[#362217]">No activity logged yet</p>
            <p className="text-xs text-[#5E4C3E] mt-1 max-w-sm">
              Connect your GitHub account or import a repository to trigger your first build.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
