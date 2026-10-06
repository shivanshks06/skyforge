import express from "express";
import {
  triggerDeployment,
  retryDeployment,
  rollbackDeployment,
  destroyDeploymentInfrastructure,
  getDeploymentQueuePosition,
  getDeployment,
  streamDeploymentLogs,
  getProjectDeployments,
  restoreDeployment,
  getDiagnosis,
  getDeploymentHistory,
} from "../controllers/deploymentController.js";
import protect from "../middleware/authMiddleware.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = express.Router();
const logStreamLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  prefix: "deployment-log-stream",
  keyResolver: (req) => req.user?.id || req.ip,
  message: "Too many deployment log streams. Please try again later.",
});

const deploymentMutationLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  prefix: "deployment-mutation",
  keyResolver: (req) => req.user?.id || req.ip,
  message: "Too many deployment or teardown requests. Please try again later.",
});

// Authenticated deployment endpoints
router.use(protect);
router.get("/history", getDeploymentHistory);
router.get("/:id/logs/stream", logStreamLimit, streamDeploymentLogs);
router.get("/:id/diagnosis", getDiagnosis);
router.post("/:id/restore", deploymentMutationLimit, restoreDeployment);
router.post("/project/:projectId", deploymentMutationLimit, triggerDeployment);
router.post("/project/:projectId/destroy", deploymentMutationLimit, destroyDeploymentInfrastructure);
router.post("/:id/retry", deploymentMutationLimit, retryDeployment);
router.post("/:id/rollback", deploymentMutationLimit, rollbackDeployment);
router.post("/:id/destroy", deploymentMutationLimit, destroyDeploymentInfrastructure);
router.get("/:id/queue-position", getDeploymentQueuePosition);
router.get("/:id", getDeployment);
router.get("/project/:projectId", getProjectDeployments);

export default router;
