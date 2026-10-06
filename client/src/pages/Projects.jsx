import { useState, useEffect, useContext } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import Card from "../components/Card";
import Button from "../components/Button";
import Input from "../components/Input";
import ProjectCard from "../components/ProjectCard";
import StatusBadge from "../components/StatusBadge";
import { projectState } from "../utils/projectState";
import {
  FolderGit2,
  Plus,
  Search,
  GitBranch,
  GitPullRequest,
  LayoutGrid,
  List,
  RefreshCw,
  Trash2,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { AuthContext } from "../context/authContext.js";
import { getGithubLoginUrl, getProjects, createProject, deleteProject, analyzeRepository } from "../services/api";

/** "owner/repo", a GitHub URL, or a URL with /tree/<branch> → { owner, repo, branch }. */
function parseRepository(value) {
  const text = String(value || "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const match = text.match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/tree\/([\w./-]+))?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2], branch: match[3] || "" };
}

const PRESETS = {
  REACT_VITE: { label: "React / Vite / SPA", framework: "React + Vite", language: "JavaScript", packageManager: "npm", buildTool: "Vite", buildCommand: "npm run build", startCommand: "npm run preview", port: 80, deploymentTarget: "AWS ECS Fargate" },
  NEXTJS: { label: "Next.js (Fullstack / SSR)", framework: "Next.js", language: "TypeScript", packageManager: "npm", buildTool: "Next.js", buildCommand: "npm run build", startCommand: "npm start", port: 3000, deploymentTarget: "AWS ECS Fargate" },
  EXPRESS: { label: "Node.js / Express Backend", framework: "Express", language: "JavaScript", packageManager: "npm", buildTool: "Node.js", buildCommand: "", startCommand: "node server.js", port: 5000, deploymentTarget: "AWS ECS Fargate" },
  FASTAPI: { label: "Python FastAPI", framework: "FastAPI", language: "Python", packageManager: "pip", buildTool: "Uvicorn", buildCommand: "", startCommand: "uvicorn main:app --host 0.0.0.0 --port 8000", port: 8000, deploymentTarget: "AWS ECS Fargate" },
  FLASK: { label: "Python Flask", framework: "Flask", language: "Python", packageManager: "pip", buildTool: "Gunicorn", buildCommand: "", startCommand: "gunicorn --bind 0.0.0.0:5000 app:app", port: 5000, deploymentTarget: "AWS ECS Fargate" },
  DJANGO: { label: "Python Django", framework: "Django", language: "Python", packageManager: "pip", buildTool: "Django", buildCommand: "", startCommand: "gunicorn app.wsgi:application --bind 0.0.0.0:8000", port: 8000, deploymentTarget: "AWS ECS Fargate" },
  LARAVEL: { label: "Laravel (PHP / Apache)", framework: "Laravel", language: "PHP", packageManager: "composer", buildTool: "Composer", buildCommand: "", startCommand: "", port: 8000, deploymentTarget: "AWS ECS Fargate" },
  GO: { label: "Go Backend", framework: "Go", language: "Go", packageManager: "go", buildTool: "Go CLI", buildCommand: "CGO_ENABLED=0 go build -o server .", startCommand: "./server", port: 8080, deploymentTarget: "AWS ECS Fargate" },
  RUST: { label: "Rust Backend", framework: "Rust", language: "Rust", packageManager: "cargo", buildTool: "Cargo", buildCommand: "cargo build --release", startCommand: "./target/release/app", port: 8080, deploymentTarget: "AWS ECS Fargate" },
  SPRINGBOOT: { label: "Java Spring Boot", framework: "Spring Boot", language: "Java", packageManager: "maven", buildTool: "Maven", buildCommand: "mvn clean package -DskipTests", startCommand: "java -jar app.jar", port: 8080, deploymentTarget: "AWS ECS Fargate" },
  STATIC: { label: "Static HTML / CSS / JS", framework: "Static HTML", language: "HTML", packageManager: "none", buildTool: "Nginx", buildCommand: "", startCommand: "", port: 80, deploymentTarget: "AWS ECS Fargate" },
};

export default function Projects() {
  const { isGithubConnected } = useContext(AuthContext);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [searchTerm, setSearchTerm] = useState(() => searchParams.get("search") || "");
  const [showModal, setShowModal] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [selectedPreset, setSelectedPreset] = useState("AUTO");
  const [branchName, setBranchName] = useState("");
  const [customPort, setCustomPort] = useState("");
  // Values the user typed win over detected ones.
  const [branchEdited, setBranchEdited] = useState(false);
  const [portEdited, setPortEdited] = useState(false);
  const [detection, setDetection] = useState({ status: "idle" });
  const [projectsList, setProjectsList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [viewMode, setViewMode] = useState("cards"); // 'cards' or 'compact'
  const [projectToDelete, setProjectToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const handlePresetChange = (presetKey) => {
    setSelectedPreset(presetKey);
    const preset = presetKey === "AUTO" ? null : PRESETS[presetKey];
    if (preset) setCustomPort(String(preset.port));
    else if (detection.report?.detection?.port) setCustomPort(String(detection.report.detection.port));
    setPortEdited(false);
  };

  // Detect language, framework, branch and port from the repository as soon as it is entered.
  const parsedRepo = parseRepository(repoUrl);
  const detectBranch = branchEdited ? branchName.trim() : parsedRepo?.branch || "";
  const detectKey = parsedRepo ? `${parsedRepo.owner}/${parsedRepo.repo}@${detectBranch}` : "";
  useEffect(() => {
    if (!showModal || !detectKey) return undefined;
    let cancelled = false;
    const task = window.setTimeout(async () => {
      setDetection({ status: "detecting", key: detectKey });
      try {
        const report = await analyzeRepository({ owner: parsedRepo.owner, repo: parsedRepo.repo, branch: detectBranch });
        if (cancelled) return;
        setDetection({ status: "done", key: detectKey, report });
        if (!branchEdited) setBranchName(report.branch || "");
        if (!portEdited && report.detection?.port) setCustomPort(String(report.detection.port));
        setProjectName((current) => current || parsedRepo.repo.toLowerCase());
      } catch (detectError) {
        if (!cancelled) setDetection({ status: "failed", key: detectKey, message: detectError.response?.data?.message || "Could not read the repository." });
      }
    }, 700);
    return () => {
      cancelled = true;
      window.clearTimeout(task);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectKey, showModal]);

  const detected = detection.status === "done" && detection.key === detectKey ? detection.report : null;

  const loadProjects = () => {
    setLoading(true);
    getProjects()
      .then((data) => {
        if (Array.isArray(data)) {
          setProjectsList(data);
        }
      })
      .catch((err) => {
        console.error("Could not fetch user projects:", err);
        setProjectsList([]);
      })
      .finally(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    const task = window.setTimeout(() => setSearchTerm(searchParams.get("search") || ""), 0);
    return () => window.clearTimeout(task);
  }, [searchParams]);

  useEffect(() => {
    const task = window.setTimeout(() => void loadProjects(), 0);
    return () => window.clearTimeout(task);
  }, []);

  const handleCreateProject = async (e) => {
    e.preventDefault();
    setError("");
    if (!projectName.trim()) return;

    const formattedName = projectName.trim().toLowerCase().replace(/\s+/g, "-");
    const formattedRepo = repoUrl.trim() || `user/${formattedName}`;
    if (selectedPreset === "AUTO" && !detected) {
      setError(detection.status === "detecting" ? "Still detecting the repository; try again in a moment." : "Auto-detect could not read this repository. Check the name, or pick a framework preset.");
      return;
    }
    const found = detected?.detection;
    const preset = selectedPreset === "AUTO" ? found : PRESETS[selectedPreset] || PRESETS.REACT_VITE;
    const port = Number(customPort) || preset.port || 80;

    setCreating(true);
    try {
      const created = await createProject({
        name: formattedName,
        repoName: formattedRepo,
        branch: branchName.trim() || detected?.branch || "main",
        framework: preset.framework,
        language: preset.language,
        packageManager: preset.packageManager,
        buildTool: preset.buildTool,
        buildCommand: preset.buildCommand,
        startCommand: preset.startCommand,
        port,
        dockerized: selectedPreset === "AUTO" ? Boolean(found?.dockerized) : false,
        requiredEnv: selectedPreset === "AUTO" ? found?.requiredEnv || [] : [],
        ...(selectedPreset === "AUTO" && found?.envAnalysis ? { envAnalysis: found.envAnalysis } : {}),
        confidence: selectedPreset === "AUTO" ? found?.confidence ?? 80 : 95,
        githubUrl: repoUrl.trim().startsWith("http") ? repoUrl.trim() : `https://github.com/${formattedRepo}`,
      });

      setProjectsList([created, ...projectsList]);
      setProjectName("");
      setRepoUrl("");
      setBranchName("");
      setCustomPort("");
      setBranchEdited(false);
      setPortEdited(false);
      setSelectedPreset("AUTO");
      setDetection({ status: "idle" });
      setShowModal(false);
    } catch (createError) {
      setError(createError.response?.data?.message || "Unable to create project.");
    } finally {
      setCreating(false);
    }
  };

  const [deleteError, setDeleteError] = useState(null);

  const handleConfirmDelete = async () => {
    if (!projectToDelete) return;
    try {
      setDeleting(true);
      setDeleteError(null);
      await deleteProject(projectToDelete.id);
      setProjectsList((prev) => prev.filter((p) => p.id !== projectToDelete.id));
      setProjectToDelete(null);
    } catch (err) {
      console.error("Failed to delete project:", err);
      setDeleteError(err.response?.data?.message || err.message || "Failed to delete project.");
    } finally {
      setDeleting(false);
    }
  };

  const filteredProjects = projectsList.filter((p) =>
    p.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (p.repoName && p.repoName.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const handleConnectGitHub = async () => {
    try {
      window.location.assign(await getGithubLoginUrl());
    } catch (connectError) {
      setError(connectError.response?.data?.message || "Unable to start GitHub authorization.");
    }
  };

  return (
    <div className="flex flex-col gap-6 w-full text-[#362217]">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-bold text-[#362217]">Projects</h2>
            <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-[#9E5D2D]/10 text-[#9E5D2D] border border-[#9E5D2D]/20">
              {projectsList.length} total
            </span>
          </div>
          <p className="text-xs text-[#5E4C3E] mt-1">
            Each project is one GitHub repository. Open one to deploy it, see its logs, or change its settings.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="flex items-center rounded-xl border border-[#DCD0C3] bg-white p-1">
            <button
              onClick={() => setViewMode("cards")}
              className={`p-1.5 rounded-lg transition ${
                viewMode === "cards"
                  ? "bg-[#FAF8F5] text-[#9E5D2D] shadow-xs"
                  : "text-[#8C7667] hover:text-[#362217]"
              }`}
              title="Full Intelligence View"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              onClick={() => setViewMode("compact")}
              className={`p-1.5 rounded-lg transition ${
                viewMode === "compact"
                  ? "bg-[#FAF8F5] text-[#9E5D2D] shadow-xs"
                  : "text-[#8C7667] hover:text-[#362217]"
              }`}
              title="Compact View"
            >
              <List className="h-4 w-4" />
            </button>
          </div>

          {isGithubConnected ? (
            <Button
              variant="outline"
              size="sm"
              icon={RefreshCw}
              onClick={loadProjects}
            >
              Refresh
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

          <Button icon={Plus} size="sm" onClick={() => setShowModal(true)}>
            New Project
          </Button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-[#9E2A2B]/30 bg-[#9E2A2B]/10 px-4 py-3 text-xs text-[#7E2223]">{error}</div>}

      {/* Filter and Search Bar */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-3 h-4 w-4 text-[#8C7667]" />
          <input
            type="text"
            placeholder="Search projects by name or repository..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-xl border border-[#DCD0C3] bg-white pl-10 pr-4 py-2.5 text-xs text-[#362217] placeholder-[#A39284] outline-none focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D] transition shadow-xs"
          />
        </div>
      </div>

      {/* Projects Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-5" aria-busy="true" aria-label="Loading projects">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="flex flex-col gap-3 rounded-3xl border border-[#EAE1D5] bg-white p-5">
              <div className="skeleton h-5 w-1/2" />
              <div className="skeleton h-3 w-2/3" />
              <div className="flex gap-2"><div className="skeleton h-5 w-16" /><div className="skeleton h-5 w-16" /><div className="skeleton h-5 w-14" /></div>
              <div className="skeleton h-9 w-36" />
            </div>
          ))}
        </div>
      ) : filteredProjects.length > 0 ? (
        viewMode === "cards" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-5">
            {filteredProjects.map((proj) => (
              <ProjectCard key={proj.id} project={proj} onDelete={setProjectToDelete} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredProjects.map((proj) => (
              <Card key={proj.id} glow={false} className="flex flex-col justify-between gap-5 bg-white border border-[#EAE1D5]">
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div className="p-2.5 rounded-xl bg-[#9E5D2D]/10 border border-[#9E5D2D]/20 text-[#9E5D2D]">
                      <FolderGit2 className="h-5 w-5" />
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge state={projectState(proj)} size="xs" />
                      <button
                        onClick={() => setProjectToDelete(proj)}
                        className="p-1 rounded-lg text-[#8C7667] hover:text-[#9E2A2B] hover:bg-[#9E2A2B]/10 transition"
                        title="Delete Project"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-base font-bold text-[#362217]">{proj.name}</h3>
                    <p className="text-xs text-[#5E4C3E] flex items-center gap-1.5 mt-1 font-mono">
                      <GitBranch className="h-3.5 w-3.5 text-[#8C7667]" /> {proj.repoName}:{proj.branch || "main"}
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-between border-t border-[#EADFCF] pt-3 text-xs">
                  <div className="flex flex-col">
                    <span className="text-[#8C7667] font-medium">{proj.framework || "Auto Detect"}</span>
                    <span className="font-mono text-[#9E5D2D] font-bold">Port {proj.port || 5173}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Link to={`/project/${proj.id}/infrastructure`} title="AWS Infrastructure" className="rounded-lg border-2 border-[#362217] bg-white px-3 py-2 text-xs font-semibold hover:bg-[#F4EFEA]">Infra</Link>
                    <Link to={`/project/${proj.id}/docker`} title="Docker" className="rounded-lg border-2 border-[#362217] bg-white px-3 py-2 text-xs font-semibold hover:bg-[#F4EFEA]">Docker</Link>
                    <Link to={`/project/${proj.id}/plan`} title="Plan" className="rounded-lg border-2 border-[#362217] bg-white px-3 py-2 text-xs font-semibold hover:bg-[#F4EFEA]">Plan</Link>
                    <Link to={`/project/${proj.id}/deploy`} title="Deploy" className="rounded-lg border-2 border-[#362217] bg-white px-3 py-2 text-xs font-semibold hover:bg-[#F4EFEA]">Deploy</Link>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )
      ) : (
        <Card hoverable={false} className="flex flex-col items-center justify-center py-12 text-center bg-white border border-[#EAE1D5]">
          <div className="p-4 rounded-2xl bg-[#F8F4EE] border border-[#EADFCF] mb-3">
            <FolderGit2 className="h-8 w-8 text-[#9E5D2D]" />
          </div>
          <h3 className="text-base font-bold text-[#362217]">No Projects Created Yet</h3>
          <p className="text-xs text-[#5E4C3E] mt-1 max-w-sm mb-4">
            {isGithubConnected
              ? "Import a repository from the Dashboard to generate an automated deployment profile."
              : "Import a GitHub repository from the Dashboard or create a project manually to get started."}
          </p>
          <div className="flex items-center gap-3">
            {isGithubConnected ? (
              <Button
                size="sm"
                icon={FolderGit2}
                onClick={() => navigate("/dashboard")}
              >
                Import from Dashboard
              </Button>
            ) : (
              <Button
                size="sm"
                icon={GitPullRequest}
                onClick={handleConnectGitHub}
              >
                Connect GitHub
              </Button>
            )}
            <Button size="sm" variant="outline" icon={Plus} onClick={() => setShowModal(true)}>
              Create Project Manually
            </Button>
          </div>
        </Card>
      )}

      {/* Modal for Creating New Project */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#362217]/50 backdrop-blur-sm p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="create-project-title" className="w-full max-w-lg rounded-3xl border border-[#EAE1D5] bg-white p-6 shadow-2xl">
            <h3 id="create-project-title" className="text-lg font-bold text-[#362217] mb-1">Create New Project</h3>
            <p className="text-xs text-[#5E4C3E] mb-5">Paste a repository: language, framework, branch and port are detected automatically. You can still override any of them.</p>

            {error && (
              <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-600">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleCreateProject} className="flex flex-col gap-3.5">
              <Input
                label="Project Name"
                placeholder="my-awesome-app"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                required
              />

              <Input
                label="GitHub Repository (owner/repo or URL)"
                placeholder="github-username/my-awesome-app"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                required
              />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label htmlFor="project-preset" className="text-xs font-semibold text-[#5E4C3E]">Framework / Language Preset</label>
                  <select
                    value={selectedPreset}
                    onChange={(e) => handlePresetChange(e.target.value)}
                    className="w-full rounded-xl border border-[#DCD0C3] bg-white px-3 py-2.5 text-xs text-[#362217] outline-none focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D] transition shadow-xs"
                  >
                    <option value="AUTO">
                      {detected ? `Auto-detected: ${detected.detection.framework}` : "Auto-detect (recommended)"}
                    </option>
                    {Object.entries(PRESETS).map(([key, item]) => (
                      <option key={key} value={key}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <Input
                    label="Branch"
                    placeholder={detection.status === "detecting" ? "detecting…" : "auto"}
                    value={branchName}
                    onChange={(e) => {
                      setBranchName(e.target.value);
                      setBranchEdited(Boolean(e.target.value.trim()));
                    }}
                  />
                  <Input
                    label="Port"
                    placeholder={detection.status === "detecting" ? "detecting…" : "auto"}
                    type="number"
                    value={customPort}
                    onChange={(e) => {
                      setCustomPort(e.target.value);
                      setPortEdited(Boolean(e.target.value));
                    }}
                  />
                </div>
              </div>

              <div className="p-3 rounded-xl bg-[#FAF8F5] border border-[#EAE1D5] text-[11px] text-[#5E4C3E] flex flex-col gap-1">
                {!parsedRepo && <span>Enter a repository to detect its stack.</span>}
                {parsedRepo && detection.status === "detecting" && (
                  <span className="flex items-center gap-1.5"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Reading {parsedRepo.owner}/{parsedRepo.repo}…</span>
                )}
                {detected && (
                  <>
                    <span className="flex items-center gap-1.5 text-[#2E6B4F] font-semibold"><CheckCircle2 className="h-3.5 w-3.5" /> Detected from the repository{detected.detection.confidence ? ` (${detected.detection.confidence}% confidence)` : ""}</span>
                    <span>
                      <strong className="text-[#362217]">{detected.detection.framework}</strong> · {detected.detection.language} · branch <strong className="text-[#362217]">{detected.branch}</strong> · port <strong className="text-[#362217]">{detected.detection.port}</strong>
                      {detected.detection.dockerized ? " · has a Dockerfile" : ""}
                      {detected.detection.requiredEnv?.length ? ` · ${detected.detection.requiredEnv.length} required env var(s)` : ""}
                    </span>
                    {selectedPreset !== "AUTO" && <span className="text-amber-700">You picked a preset; it overrides the detected framework.</span>}
                  </>
                )}
                {parsedRepo && detection.status === "failed" && detection.key === detectKey && (
                  <span className="text-amber-700">{detection.message} Pick a framework preset and enter the branch and port yourself.</span>
                )}
                <span>The deployment target (ECS Fargate or CloudFront) is chosen later on the Infrastructure page.</span>
              </div>

              <div className="flex items-center justify-end gap-3 mt-2 pt-3 border-t border-[#EAE1D5]">
                <Button type="button" variant="outline" size="sm" onClick={() => setShowModal(false)} disabled={creating}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" loading={creating} disabled={selectedPreset === "AUTO" && detection.status === "detecting"}>
                  Create Project Profile
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Modal for Deleting Project */}
      {projectToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#362217]/50 backdrop-blur-sm p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="delete-project-title" className="w-full max-w-md rounded-3xl border border-[#EAE1D5] bg-white p-6 shadow-2xl flex flex-col gap-4">
            <div className="flex items-center gap-3 text-[#9E2A2B]">
              <div className="p-3 rounded-2xl bg-[#9E2A2B]/10 border border-[#9E2A2B]/20">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <div>
                <h3 id="delete-project-title" className="text-base font-bold text-[#362217]">Delete Project?</h3>
                <p className="text-xs text-[#8C7667]">This action cannot be undone.</p>
              </div>
            </div>
            <p className="text-xs text-[#5E4C3E] leading-relaxed">
              Are you sure you want to delete <strong className="text-[#362217]">{projectToDelete.name}</strong>? This permanently removes its deployment profiles and local blueprints. Any recorded cloud resources must be destroyed first.
            </p>
            {deleteError && (
              <div className="p-3 rounded-xl bg-[#9E2A2B]/10 border border-[#9E2A2B]/20 text-xs text-[#9E2A2B]">
                <p className="font-semibold">Unable to delete:</p>
                <p className="mt-0.5">{deleteError}</p>
              </div>
            )}
            <div className="flex items-center justify-end gap-3 pt-2 border-t border-[#EAE1D5]">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => { setProjectToDelete(null); setDeleteError(null); }}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleConfirmDelete}
                loading={deleting}
                className="bg-[#9E2A2B] hover:bg-[#7E2223] text-white"
              >
                Delete Project
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
