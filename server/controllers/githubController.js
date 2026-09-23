import jwt from "jsonwebtoken";
import prisma from "../config/db.js";
import {
  generatePKCE,
  buildGitHubAuthUrl,
  exchangeCodeForToken,
  getGitHubUserProfile,
  getUserRepositories,
} from "../services/githubService.js";
import { analyzeRepository } from "../services/deploymentEngine.js";

/**
 * Helper to parse cookies from request headers.
 */
const parseCookies = (req) => {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(";").forEach((cookie) => {
      const parts = cookie.split("=");
      list[parts.shift().trim()] = decodeURIComponent(parts.join("="));
    });
  }
  return list;
};

/**
 * GET /api/github/login
 * Initiates GitHub OAuth PKCE flow.
 */
export const githubLogin = async (req, res) => {
  try {
    const { codeVerifier, codeChallenge, state } = generatePKCE();

    // Extract user ID from token passed via query, header, or cookie
    let userId = req.query.userId || null;
    const tokenStr = req.query.token || (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.split(" ")[1] : null);

    if (tokenStr) {
      try {
        const decoded = jwt.verify(tokenStr, process.env.JWT_SECRET);
        userId = decoded.userId;
      } catch (err) {
        console.warn("JWT verification error in githubLogin:", err.message);
      }
    }

    const statePayload = userId ? `${state}_${userId}` : state;

    res.cookie("github_oauth_state", statePayload, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 10 * 60 * 1000,
      sameSite: "lax",
    });

    res.cookie("github_code_verifier", codeVerifier, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 10 * 60 * 1000,
      sameSite: "lax",
    });

    const authUrl = buildGitHubAuthUrl({ codeChallenge, state: statePayload });

    if (req.query.format === "json") {
      return res.json({
        url: authUrl,
        state: statePayload,
        codeChallenge,
        codeChallengeMethod: "S256",
      });
    }

    return res.redirect(authUrl);
  } catch (error) {
    console.error("Error in githubLogin:", error);
    return res.status(500).json({
      message: "Failed to initiate GitHub authorization",
      error: error.message,
    });
  }
};

/**
 * GET /api/github/callback
 * Handles OAuth callback, exchanges code for access token, fetches profile & saves GitHubAccount.
 */
export const githubCallback = async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).json({ message: "Authorization code missing in callback." });
    }

    const cookies = parseCookies(req);
    const codeVerifier = cookies.github_code_verifier;

    // Determine target User ID from state or database
    let targetUserId = null;
    if (state && state.includes("_")) {
      targetUserId = state.split("_")[1];
    }

    if (!targetUserId) {
      // Fallback: search for last active user in DB
      const user = await prisma.user.findFirst({ orderBy: { createdAt: "desc" } });
      if (user) {
        targetUserId = user.id;
      }
    }

    if (!targetUserId) {
      return res.status(400).json({ message: "User association failed. Please log in first." });
    }

    // 1. Exchange OAuth code + code_verifier for Access Token
    const accessToken = await exchangeCodeForToken({
      code,
      codeVerifier: codeVerifier || undefined,
    });

    // 2. Fetch GitHub User Profile
    const githubUser = await getGitHubUserProfile(accessToken);

    // 3. Clean up any existing GitHubAccount records for this githubId or targetUserId to avoid unique constraint issues
    await prisma.gitHubAccount.deleteMany({
      where: {
        OR: [
          { githubId: String(githubUser.id) },
          { userId: targetUserId }
        ]
      }
    });

    // 4. Save GitHubAccount linked directly to the target User
    const githubAccount = await prisma.gitHubAccount.create({
      data: {
        userId: targetUserId,
        githubId: String(githubUser.id),
        username: githubUser.login,
        accessToken: accessToken,
      },
    });

    if (req.query.format === "json") {
      return res.json({
        message: "GitHub account linked successfully",
        account: githubAccount,
      });
    }

    // Redirect user back to Dashboard with success indicator
    return res.redirect("http://localhost:5173/dashboard?github=connected");
  } catch (error) {
    console.error("Error in githubCallback:", error);
    return res.status(500).json({
      message: "GitHub OAuth callback failed",
      error: error.message,
    });
  }
};

/**
 * GET /api/github/repos
 * Protected route to fetch repositories of the connected GitHub account.
 */
export const getRepos = async (req, res) => {
  try {
    const userId = req.user.id;

    const account = await prisma.gitHubAccount.findUnique({
      where: { userId },
    });

    if (!account) {
      return res.status(404).json({
        message: "No connected GitHub account found. Please connect GitHub first.",
      });
    }

    const repos = await getUserRepositories(account.accessToken);

    return res.json(repos);
  } catch (error) {
    console.error("Error in getRepos:", error);
    return res.status(500).json({
      message: "Failed to fetch GitHub repositories",
      error: error.message,
    });
  }
};

/**
 * POST /api/github/analyze
 * Scans repository file tree, detects framework, env variables, ports, package manager, and builds deployment plan.
 */
export const analyzeRepo = async (req, res) => {
  try {
    const { owner, repo, branch = "main" } = req.body;

    if (!owner || !repo) {
      return res.status(400).json({
        message: "Repository owner and repo name are required.",
      });
    }

    let token = null;
    if (req.user?.id) {
      const account = await prisma.gitHubAccount.findUnique({
        where: { userId: req.user.id },
      });
      if (account) {
        token = account.accessToken;
      }
    }

    const report = await analyzeRepository({ owner, repo, branch, token });
    return res.json(report);
  } catch (error) {
    console.error("Error analyzing repository:", error);
    return res.status(500).json({
      message: "Failed to analyze repository",
      error: error.message,
    });
  }
};
