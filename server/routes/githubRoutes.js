import express from "express";
import {
  githubLogin,
  githubCallback,
  getRepos,
  analyzeRepo,
  disconnectGithub,
  githubWebhook,
} from "../controllers/githubController.js";
import protect from "../middleware/authMiddleware.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = express.Router();
const githubAnalysisLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  prefix: "github-analysis",
  keyResolver: (req) => req.user?.id || req.ip,
  message: "Too many repository analysis requests. Please try again later.",
});
const githubCallbackLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  prefix: "github-oauth-callback",
  message: "Too many OAuth callback attempts. Please try again later.",
});

// GET /api/github/login - Initiates OAuth flow for the authenticated user
router.get("/login", protect, githubLogin);

// GET /api/github/callback - GitHub OAuth callback endpoint
router.get("/callback", githubCallbackLimit, githubCallback);

// GET /api/github/repos - Protected route to list user repositories
router.get("/repos", protect, getRepos);

// POST /api/github/disconnect - Protected route to disconnect GitHub
router.post("/disconnect", protect, disconnectGithub);

// POST /api/github/webhook - GitHub push / pull_request events (signed with GITHUB_WEBHOOK_SECRET)
router.post("/webhook", githubCallbackLimit, githubWebhook);

// POST /api/github/analyze - Run Repository Intelligence Engine analysis
router.post("/analyze", protect, githubAnalysisLimit, analyzeRepo);

export default router;
