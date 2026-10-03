import express from "express";
import { getAlertSettings, updateAlertSettings, sendTestAlert } from "../controllers/alertController.js";
import protect from "../middleware/authMiddleware.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = express.Router();
const alertLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  prefix: "alert-settings",
  keyResolver: (req) => req.user?.id || req.ip,
  message: "Too many alert changes. Please try again later.",
});

router.use(protect);
router.get("/", getAlertSettings);
router.put("/", alertLimit, updateAlertSettings);
router.post("/test", alertLimit, sendTestAlert);

export default router;
