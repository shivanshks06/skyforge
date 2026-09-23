import crypto from "crypto";
import axios from "axios";

const github = axios.create({
  baseURL: "https://api.github.com",
});

/**
 * Generate PKCE verifier, challenge, and state for OAuth 2.0 authorization.
 */
export const generatePKCE = () => {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");

  return { codeVerifier, codeChallenge, state };
};

/**
 * Build the GitHub OAuth Authorization URL with PKCE parameters.
 */
export const buildGitHubAuthUrl = ({ codeChallenge, state }) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    throw new Error("GITHUB_CLIENT_ID is not configured in environment variables.");
  }

  const scope = "read:user user:email repo";
  const params = new URLSearchParams({
    client_id: clientId,
    scope: scope,
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return `https://github.com/login/oauth/authorize?${params.toString()}`;
};

/**
 * Exchange OAuth code and PKCE code_verifier for GitHub access_token.
 */
export const exchangeCodeForToken = async ({ code, codeVerifier }) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  const response = await axios.post(
    "https://github.com/login/oauth/access_token",
    {
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      code_verifier: codeVerifier,
    },
    {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    }
  );

  if (response.data.error) {
    throw new Error(`GitHub token exchange error: ${response.data.error_description || response.data.error}`);
  }

  return response.data.access_token;
};

/**
 * Fetch GitHub user profile using access token.
 */
export const getGitHubUserProfile = async (accessToken) => {
  const response = await axios.get("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "SkyForge-App",
      Accept: "application/vnd.github+json",
    },
  });

  return response.data;
};

/**
 * Fetch GitHub user repositories using access token.
 */
export const getUserRepositories = async (accessToken) => {
  const response = await axios.get("https://api.github.com/user/repos?sort=updated&per_page=100", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "SkyForge-App",
      Accept: "application/vnd.github+json",
    },
  });

  return response.data.map((repo) => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    owner: repo.owner?.login,
    defaultBranch: repo.default_branch || "main",
    language: repo.language || "N/A",
    description: repo.description,
    htmlUrl: repo.html_url,
    private: repo.private,
    updatedAt: repo.updated_at,
  }));
};

/**
 * Stage 1: Get complete repository git tree (recursive = 1)
 */
export const getRepositoryTree = async (owner, repo, branch = "main", token = null) => {
  const headers = { "User-Agent": "SkyForge-App" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const { data } = await github.get(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, {
      headers,
    });
    return data.tree || [];
  } catch (err) {
    // If recursive fails or main branch differs, try branch HEAD fallback
    console.warn(`Repository tree fetch warning for ${owner}/${repo}:`, err.message);
    return [];
  }
};

/**
 * Stage 2: Fetch contents of a specific important file
 */
export const getFile = async (owner, repo, path, token = null) => {
  const headers = { "User-Agent": "SkyForge-App" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const { data } = await github.get(`/repos/${owner}/${repo}/contents/${path}`, {
      headers,
    });

    if (data.content && data.encoding === "base64") {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    return typeof data === "string" ? data : JSON.stringify(data);
  } catch (err) {
    return null;
  }
};
