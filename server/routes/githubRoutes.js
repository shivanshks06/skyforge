import express from "express";
import { githubLogin, githubCallback, getRepos, analyzeRepo } from "../controllers/githubController.js";
import protect from "../middleware/authMiddleware.js";

const router = express.Router();

// GET /api/github/login - Initiates OAuth flow
router.get("/login", githubLogin);

// GET /api/github/callback - GitHub OAuth callback endpoint
router.get("/callback", githubCallback);

// GET /api/github/repos - Protected route to list user repositories
router.get("/repos", protect, getRepos);

// POST /api/github/analyze - Run Repository Intelligence Engine analysis
router.post("/analyze", analyzeRepo);

export default router;
