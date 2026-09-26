import prisma from "../config/db.js";
import {
  generatePKCE,
  buildGitHubAuthUrl,
  exchangeCodeForToken,
  getGitHubUserProfile,
  getUserRepositories,
  revokeGitHubToken,
} from "../services/githubService.js";
import { analyzeRepository } from "../services/deploymentEngine.js";
import { decryptSecret, encryptSecret } from "../services/secretService.js";

function parseCookies(req) {
  return (req.headers.cookie || "").split(";").reduce((cookies, item) => {
    const separator = item.indexOf("=");
    if (separator < 0) return cookies;
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1);
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
    return cookies;
  }, {});
}

function clientUrl(pathname = "/dashboard") {
  const configured = String(process.env.CLIENT_URL || "http://localhost:5173").split(",")[0].trim();
  const url = new URL(pathname, configured);
  return url.toString();
}

function secureOAuthCookies() {
  const configured = String(process.env.CLIENT_URL || "").split(",")[0].trim();
  const localClient = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(configured);
  return process.env.NODE_ENV === "production" && !localClient;
}

function clearOAuthCookie(res, name) {
  res.cookie(name, "", {
    httpOnly: true,
    secure: secureOAuthCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export const githubLogin = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Authentication required" });

    const { codeVerifier, codeChallenge, state } = generatePKCE();
    const statePayload = `${state}.${userId}`;
    const cookieOptions = {
      httpOnly: true,
      secure: secureOAuthCookies(),
      maxAge: 10 * 60 * 1000,
      sameSite: "lax",
      path: "/",
    };

    res.cookie("github_oauth_state", statePayload, cookieOptions);
    res.cookie("github_code_verifier", codeVerifier, cookieOptions);

    const authUrl = buildGitHubAuthUrl({ codeChallenge, state: statePayload });
    if (req.query.format === "json") {
      return res.json({ url: authUrl, state: statePayload, codeChallenge, codeChallengeMethod: "S256" });
    }
    return res.redirect(authUrl);
  } catch (error) {
    console.error("Error in githubLogin:", error);
    return res.status(500).json({ message: "Failed to initiate GitHub authorization" });
  }
};

export const githubCallback = async (req, res) => {
  try {
    const { code, state } = req.query;
    const cookies = parseCookies(req);
    if (!code) return res.status(400).json({ message: "Authorization code missing in callback." });
    if (!state || !cookies.github_oauth_state || state !== cookies.github_oauth_state) {
      return res.status(400).json({ message: "GitHub OAuth state validation failed." });
    }

    const separator = state.lastIndexOf(".");
    const targetUserId = separator > 0 ? state.slice(separator + 1) : "";
    const user = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
    if (!user) return res.status(400).json({ message: "OAuth user no longer exists." });

    const accessToken = await exchangeCodeForToken({
      code,
      codeVerifier: cookies.github_code_verifier,
    });
    const githubUser = await getGitHubUserProfile(accessToken);
    const githubId = String(githubUser.id);

    await prisma.$transaction(async (tx) => {
      const existingGithubAccount = await tx.gitHubAccount.findUnique({ where: { githubId } });
      if (existingGithubAccount && existingGithubAccount.userId !== targetUserId) {
        throw new Error("This GitHub account is already linked to another SkyForge user.");
      }

      await tx.gitHubAccount.upsert({
        where: { userId: targetUserId },
        update: {
          githubId,
          username: githubUser.login,
          accessToken: encryptSecret(accessToken),
        },
        create: {
          userId: targetUserId,
          githubId,
          username: githubUser.login,
          accessToken: encryptSecret(accessToken),
        },
      });
    });

    clearOAuthCookie(res, "github_oauth_state");
    clearOAuthCookie(res, "github_code_verifier");

    if (req.query.format === "json") {
      return res.json({ message: "GitHub account linked successfully", github: { githubId, username: githubUser.login } });
    }
    return res.redirect(clientUrl("/dashboard?github=connected"));
  } catch (error) {
    clearOAuthCookie(res, "github_oauth_state");
    clearOAuthCookie(res, "github_code_verifier");
    console.error("Error in githubCallback:", error.response?.status || error.message);
    return res.status(400).json({ message: error.response?.data?.error_description || error.message || "GitHub OAuth callback failed" });
  }
};

export const getRepos = async (req, res) => {
  try {
    const account = await prisma.gitHubAccount.findUnique({ where: { userId: req.user.id } });
    if (!account) return res.status(404).json({ message: "No connected GitHub account found." });
    const repos = await getUserRepositories(decryptSecret(account.accessToken));
    return res.json(repos);
  } catch (error) {
    console.error("Error in getRepos:", error.response?.status || error.message);
    return res.status(500).json({ message: "Failed to fetch GitHub repositories" });
  }
};

export const disconnectGithub = async (req, res) => {
  try {
    const account = await prisma.gitHubAccount.findUnique({ where: { userId: req.user.id } });
    if (account) {
      await revokeGitHubToken(decryptSecret(account.accessToken)).catch((error) => {
        console.warn(`[GITHUB] Token revocation failed: ${error.message}`);
      });
      await prisma.gitHubAccount.delete({ where: { userId: req.user.id } });
    }
    return res.json({ message: "GitHub account disconnected successfully." });
  } catch (error) {
    console.error("Error in disconnectGithub:", error.message);
    return res.status(500).json({ message: "Failed to disconnect GitHub account" });
  }
};

export const analyzeRepo = async (req, res) => {
  try {
    const owner = String(req.body?.owner || "").trim();
    const repo = String(req.body?.repo || "").trim();
    const branch = String(req.body?.branch || "main").trim();
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo) || [owner, repo].some((value) => value === "." || value === "..") || !/^[\w./-]+$/.test(branch) || branch.length > 255 || branch.includes("..")) {
      return res.status(400).json({ message: "Repository owner, name, and branch are invalid." });
    }

    const account = await prisma.gitHubAccount.findUnique({ where: { userId: req.user.id } });
    const token = account ? decryptSecret(account.accessToken) : null;
    const report = await analyzeRepository({ owner, repo, branch, token });

    if (!report?.detection) {
      return res.status(422).json({ message: "Repository could not be analyzed. Verify access and branch name." });
    }
    return res.json(report);
  } catch (error) {
    console.error("Error analyzing repository:", error.message);
    return res.status(500).json({ message: "Failed to analyze repository" });
  }
};
