import crypto from "crypto";
import dns from "node:dns";
import https from "node:https";
import axios from "axios";

// Prefer IPv4 for DNS resolution and connection
dns.setDefaultResultOrder("ipv4first");

// Dedicated IPv4 HTTPS agent to avoid IPv6/DNS64 NAT64 connection timeouts
const httpsAgent = new https.Agent({
  family: 4,
  keepAlive: true,
});

axios.defaults.httpsAgent = httpsAgent;

const github = axios.create({
  baseURL: "https://api.github.com",
  httpsAgent,
  timeout: 20000,
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
      httpsAgent,
      timeout: 20000,
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
export const revokeGitHubToken = async (accessToken) => {
  if (!accessToken) return;
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GitHub OAuth credentials are not configured.");
  await axios.delete(`https://api.github.com/applications/${encodeURIComponent(clientId)}/token`, {
    data: new URLSearchParams({ access_token: accessToken }).toString(),
    auth: { username: clientId, password: clientSecret },
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "SkyForge-App",
    },
    httpsAgent,
    timeout: 15_000,
  });
};

export const getGitHubUserProfile = async (accessToken) => {
  const response = await axios.get("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "SkyForge-App",
      Accept: "application/vnd.github+json",
    },
    httpsAgent,
    timeout: 20000,
  });

  return response.data;
};

/**
 * Fetch GitHub user repositories using access token.
 */
export const getUserRepositories = async (accessToken) => {
  let response;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      response = await axios.get("https://api.github.com/user/repos?sort=updated&per_page=100", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "SkyForge-App",
          Accept: "application/vnd.github+json",
        },
        httpsAgent,
        timeout: 20000,
      });
      break;
    } catch (err) {
      if (attempt < 2 && (err.code === "ECONNRESET" || err.message?.includes("hang up"))) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      throw err;
    }
  }

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
export async function getRepositoryTreeWithRef(owner, repo, branch = "main", token = null) {
  const headers = { "User-Agent": "SkyForge-App" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const request = async (ref) => {
    const { data } = await github.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers });
    return { tree: data.tree || [], ref };
  };

  try {
    return await request(branch);
  } catch (error) {
    if (branch === "main") {
      try {
        return await request("master");
      } catch {}
    }
    try {
      const repoInfo = await github.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { headers });
      const defaultBranch = repoInfo.data?.default_branch;
      if (defaultBranch && defaultBranch !== branch && defaultBranch !== "master") return await request(defaultBranch);
    } catch {}
    console.warn(`Repository tree fetch warning for ${owner}/${repo}:`, error.message);
    return { tree: [], ref: branch };
  }
}

export const getRepositoryTree = async (owner, repo, branch = "main", token = null) =>
  (await getRepositoryTreeWithRef(owner, repo, branch, token)).tree;

/**
 * Stage 2: Fetch contents of a specific important file
 */
export const getFile = async (owner, repo, path, token = null, ref = null) => {
  const headers = { "User-Agent": "SkyForge-App" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const encodedPath = String(path).split("/").map((part) => encodeURIComponent(part)).join("/");
    const { data } = await github.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, {
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
