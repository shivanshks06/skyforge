import prisma from "../config/db.js";
import { requireOwnedProject } from "../services/ownershipService.js";
import { assertProjectHasNoActiveOperation } from "../services/operationGuard.js";
import { DB_ENGINES, DB_MONTHLY_ESTIMATE, publicDatabaseConfig } from "../services/rdsService.js";

/** GET: how this project gets its database. */
export const getDatabase = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    return res.json({ database: publicDatabaseConfig(project.databaseConfig), engines: Object.fromEntries(Object.entries(DB_ENGINES).map(([key, value]) => [key, value.label])), monthlyCost: DB_MONTHLY_ESTIMATE });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Failed to load database settings" });
  }
};

/**
 * POST { mode: "external" | "rds", engine?: "postgres" | "mysql" }.
 * "external": the owner pastes a connection string (e.g. Neon, Supabase, their own RDS).
 * "rds": SkyForge creates a private RDS database on the next deploy and sets DATABASE_URL.
 */
export const updateDatabase = async (req, res) => {
  try {
    const project = await requireOwnedProject(req.params.id, req.user?.id);
    await assertProjectHasNoActiveOperation(project.id);
    const mode = req.body?.mode;
    const engine = req.body?.engine || project.databaseConfig?.engine || "postgres";
    if (!["external", "rds"].includes(mode)) return res.status(400).json({ message: "mode must be external or rds." });
    if (!DB_ENGINES[engine]) return res.status(400).json({ message: "engine must be postgres or mysql." });
    if (mode === "rds" && /S3/.test(project.deploymentTarget || "")) {
      return res.status(400).json({ message: "Static sites (S3 + CloudFront) have no server to use a database. Choose an ECS target first." });
    }
    const current = project.databaseConfig || {};
    if (current.identifier && current.engine && current.engine !== engine) {
      return res.status(409).json({ message: `This project already has a ${DB_ENGINES[current.engine].label} database. Destroy the project to remove it before switching engines.` });
    }
    const next = { ...current, mode, engine };
    await prisma.project.update({ where: { id: project.id }, data: { databaseConfig: next } });
    const message = mode === "rds"
      ? `SkyForge will create a private ${DB_ENGINES[engine].label} database on the next deploy (${DB_MONTHLY_ESTIMATE}) and set DATABASE_URL automatically. Destroying the project deletes it.`
      : current.identifier
        ? "The app will use the DATABASE_URL you set. The existing SkyForge database keeps running (and billing) until you destroy the project."
        : "The app will use the DATABASE_URL you set on the Environment page.";
    return res.json({ message, database: publicDatabaseConfig(next) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Failed to update database settings" });
  }
};
