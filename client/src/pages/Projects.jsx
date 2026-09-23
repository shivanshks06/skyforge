import { useState, useEffect } from "react";
import Card from "../components/Card";
import Button from "../components/Button";
import Input from "../components/Input";
import { FolderGit2, Plus, Search, GitBranch, GitPullRequest } from "lucide-react";
import { getProjects, createProject } from "../services/api";

export default function Projects() {
  const [searchTerm, setSearchTerm] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [projectsList, setProjectsList] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getProjects()
      .then((data) => {
        if (Array.isArray(data)) {
          const formatted = data.map((p) => ({
            id: p.id,
            name: p.name,
            repoName: p.repoName,
            branch: p.branch,
            status: p.status || "Imported",
            updatedAt: "Recently",
            framework: p.framework || "Auto Detect"
          }));
          setProjectsList(formatted);
        }
      })
      .catch((err) => {
        console.error("Could not fetch user projects:", err);
        setProjectsList([]);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const handleCreateProject = async (e) => {
    e.preventDefault();
    if (!projectName) return;

    const formattedName = projectName.toLowerCase().replace(/\s+/g, "-");
    const formattedRepo = repoUrl || `user/${formattedName}`;

    try {
      const created = await createProject({
        name: formattedName,
        repoName: formattedRepo,
        branch: "main",
        framework: "Auto Detect",
        githubUrl: repoUrl || `https://github.com/${formattedRepo}`,
      });

      setProjectsList([
        {
          id: created.id,
          name: created.name,
          repoName: created.repoName,
          branch: created.branch,
          status: created.status,
          updatedAt: "Just now",
          framework: created.framework || "Auto Detect",
        },
        ...projectsList,
      ]);
    } catch {
      // Fallback
    }

    setProjectName("");
    setRepoUrl("");
    setShowModal(false);
  };

  const filteredProjects = projectsList.filter((p) =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (p.repoName && p.repoName.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  return (
    <div className="flex flex-col gap-6 w-full text-[#362217]">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-[#362217]">Projects</h2>
          <p className="text-xs text-[#5E4C3E] mt-1">Manage and deploy your Git repositories</p>
        </div>
        <Button icon={Plus} size="sm" onClick={() => setShowModal(true)}>
          New Project
        </Button>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-3 h-4 w-4 text-[#8C7667]" />
          <input
            type="text"
            placeholder="Search projects..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-xl border border-[#DCD0C3] bg-white pl-10 pr-4 py-2.5 text-xs text-[#362217] placeholder-[#A39284] outline-none focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D] transition shadow-sm"
          />
        </div>
      </div>

      {/* Projects Grid */}
      {loading ? (
        <div className="flex justify-center py-12 text-xs text-[#8C7667]">
          Loading projects...
        </div>
      ) : filteredProjects.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredProjects.map((proj) => (
            <Card key={proj.id} glow={false} className="flex flex-col justify-between gap-6 bg-white border border-[#EAE1D5]">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="p-2.5 rounded-xl bg-[#9E5D2D]/10 border border-[#9E5D2D]/20 text-[#9E5D2D]">
                    <FolderGit2 className="h-5 w-5" />
                  </div>
                  <span className={`text-[10px] font-semibold px-2.5 py-1 rounded-full border ${
                    proj.status === "Live" 
                      ? "bg-[#2E6B4F]/10 text-[#2E6B4F] border-[#2E6B4F]/30" 
                      : "bg-[#9E5D2D]/10 text-[#9E5D2D] border-[#9E5D2D]/30"
                  }`}>
                    {proj.status}
                  </span>
                </div>

                <div>
                  <h3 className="text-lg font-bold text-[#362217]">{proj.name}</h3>
                  <p className="text-xs text-[#5E4C3E] flex items-center gap-1.5 mt-1 font-mono">
                    <GitBranch className="h-3.5 w-3.5 text-[#8C7667]" /> {proj.repoName}:{proj.branch}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-[#EADFCF] pt-4 text-xs">
                <span className="text-[#8C7667]">{proj.framework}</span>
                <span className="text-[#5E4C3E] font-medium">{proj.updatedAt}</span>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card hoverable={false} className="flex flex-col items-center justify-center py-12 text-center bg-white border border-[#EAE1D5]">
          <div className="p-4 rounded-2xl bg-[#F8F4EE] border border-[#EADFCF] mb-3">
            <FolderGit2 className="h-8 w-8 text-[#9E5D2D]" />
          </div>
          <h3 className="text-base font-bold text-[#362217]">No Projects Created Yet</h3>
          <p className="text-xs text-[#5E4C3E] mt-1 max-w-sm mb-4">
            Import a GitHub repository from the Dashboard or create a project manually to get started.
          </p>
          <div className="flex items-center gap-3">
            <Button 
              size="sm" 
              icon={GitPullRequest} 
              onClick={() => {
                const token = localStorage.getItem("token");
                window.location.href = token 
                  ? `http://localhost:5000/api/github/login?token=${token}`
                  : "http://localhost:5000/api/github/login";
              }}
            >
              Connect GitHub
            </Button>
            <Button size="sm" variant="outline" icon={Plus} onClick={() => setShowModal(true)}>
              Create Project
            </Button>
          </div>
        </Card>
      )}

      {/* Modal for Creating New Project */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#362217]/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl border border-[#EAE1D5] bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-[#362217] mb-2">Create New Project</h3>
            <p className="text-xs text-[#5E4C3E] mb-6">Link a repository to automatically generate infrastructure specs.</p>
            
            <form onSubmit={handleCreateProject} className="flex flex-col gap-4">
              <Input
                label="Project Name"
                placeholder="my-awesome-app"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                required
              />
              <Input
                label="GitHub Repository URL"
                placeholder="https://github.com/username/repository"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
              />
              
              <div className="flex items-center justify-end gap-3 mt-4">
                <Button type="button" variant="outline" size="sm" onClick={() => setShowModal(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm">
                  Create Project
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
