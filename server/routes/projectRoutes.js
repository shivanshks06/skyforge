import express from "express";
import {
  createProject,
  getProjects,
  getProjectById,
  deleteProject,
} from "../controllers/projectController.js";
import { generatePlan, getPlan, updateEnvVars, scanEnvironment } from "../controllers/planningController.js";
import {
  getDockerConfig,
  updateDockerStrategy,
  validateDockerContent,
  saveDockerFiles,
} from "../controllers/dockerController.js";
import { getInfrastructure, updateInfrastructureTarget } from "../controllers/infrastructureController.js";
import { getSecurity, setSecurityTier, setUnderAttack, unbanIp, runSecurityScan, createSecurityFix, takeOffline, bringOnline } from "../controllers/securityController.js";
import protect from "../middleware/authMiddleware.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = express.Router();
const planningLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  prefix: "project-planning",
  keyResolver: (req) => req.user?.id || req.ip,
  message: "Too many planning or environment updates. Please try again later.",
});
const blueprintMutationLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  prefix: "project-blueprint-mutation",
  keyResolver: (req) => req.user?.id || req.ip,
  message: "Too many blueprint updates. Please try again later.",
});

router.use(protect);

router.post("/", createProject);
router.get("/", getProjects);
router.get("/:id", getProjectById);
router.delete("/:id", deleteProject);

// Sprint 5 Planning & Blueprint routes
router.post("/:id/plan", planningLimit, generatePlan);
router.get("/:id/plan", planningLimit, getPlan);
router.post("/:id/env", planningLimit, updateEnvVars);
router.post("/:id/env/scan", planningLimit, scanEnvironment);

// Sprint 6 Docker Strategy & Blueprint routes
router.get("/:id/docker", blueprintMutationLimit, getDockerConfig);
router.post("/:id/docker/strategy", blueprintMutationLimit, updateDockerStrategy);
router.post("/:id/docker/validate", blueprintMutationLimit, validateDockerContent);
router.post("/:id/docker/save", blueprintMutationLimit, saveDockerFiles);

// Sprint 7 Cloud Infrastructure & Terraform routes
router.get("/:id/infrastructure", blueprintMutationLimit, getInfrastructure);
router.post("/:id/infrastructure/target", blueprintMutationLimit, updateInfrastructureTarget);

// Security tiers, scans, firewall controls, and taking the site offline without destroying it
const securityLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  prefix: "project-security",
  keyResolver: (req) => req.user?.id || req.ip,
  message: "Too many security operations. Please try again later.",
});
router.get("/:id/security", getSecurity);
router.post("/:id/security/tier", securityLimit, setSecurityTier);
router.post("/:id/security/scan", securityLimit, runSecurityScan);
router.post("/:id/security/under-attack", securityLimit, setUnderAttack);
router.post("/:id/security/unban", securityLimit, unbanIp);
router.post("/:id/security/fix", securityLimit, createSecurityFix);
router.post("/:id/site/offline", securityLimit, takeOffline);
router.post("/:id/site/online", securityLimit, bringOnline);

export default router;
