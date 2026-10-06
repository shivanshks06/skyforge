import express from "express";
import {
  getAwsStatus,
  initiateAwsSetup,
  connectAwsRole,
  saveAwsCredentials,
  disconnectAws,
  getAwsReadiness,
} from "../controllers/awsConnectionController.js";
import { getCosts, updateBudget } from "../controllers/costController.js";
import protect from "../middleware/authMiddleware.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = express.Router();
const awsVerificationLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  prefix: "aws-verification",
  keyResolver: (req) => req.user?.id || req.ip,
  message: "Too many AWS verification attempts. Please try again later.",
});

router.use(protect);

router.get("/status", getAwsStatus);
router.post("/setup", initiateAwsSetup);
router.post("/connect", awsVerificationLimit, connectAwsRole);
router.post("/credentials", awsVerificationLimit, saveAwsCredentials);
router.post("/disconnect", disconnectAws);
router.get("/readiness", awsVerificationLimit, getAwsReadiness);
router.get("/costs", getCosts);
router.post("/budget", updateBudget);

export default router;
