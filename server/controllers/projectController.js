import prisma from "../config/db.js";

/**
 * Helper to get the project Prisma model safely
 */
const getProjectModel = () => {
  return prisma.project || prisma.Project;
};

/**
 * POST /api/projects
 * Create a new project (Imported from GitHub or created manually)
 */
export const createProject = async (req, res) => {
  try {
    const { name, repoName, branch = "main", framework = "Auto Detect", githubUrl } = req.body;
    const userId = req.user.id;

    if (!name || !repoName || !githubUrl) {
      return res.status(400).json({
        message: "Project name, repository name, and GitHub URL are required.",
      });
    }

    const projectModel = getProjectModel();
    const project = await projectModel.create({
      data: {
        name,
        repoName,
        branch,
        framework,
        githubUrl,
        status: "Imported",
        userId,
      },
    });

    return res.status(201).json(project);
  } catch (error) {
    console.error("Error creating project:", error);
    return res.status(500).json({
      message: "Failed to create project",
      error: error.message,
    });
  }
};

/**
 * GET /api/projects
 * Get all projects belonging to the logged-in user
 */
export const getProjects = async (req, res) => {
  try {
    const userId = req.user.id;

    const projectModel = getProjectModel();
    const projects = await projectModel.findMany({
      where: { userId },
    });

    return res.json(projects);
  } catch (error) {
    console.error("Error fetching projects:", error);
    return res.status(500).json({
      message: "Failed to fetch projects",
      error: error.message,
    });
  }
};
