import axios from "axios";

const configuredOrigin = String(import.meta.env.VITE_API_ORIGIN ?? "")
  .trim()
  .replace(/\/$/, "");
const api = axios.create({
  baseURL: `${configuredOrigin}/api`,
  timeout: 90_000,
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.config) {
      error.config = {
        url: error.config.url,
        method: error.config.method,
        params: error.config.params || {},
        headers: {},
      };
    }
    if (error.response?.config) error.response.config = { url: error.response.config?.url, method: error.response.config?.method, headers: {} };
    error.request = undefined;
    if (error.response?.status === 401 && !error.config?.url?.includes("/auth/login")) {
      window.dispatchEvent(new CustomEvent("skyforge:unauthorized"));
    }
    return Promise.reject(error);
  },
);

export const getGithubLoginUrl = async () => {
  const response = await api.get("/github/login?format=json");
  return response.data.url;
};

export const getGithubRepos = async () => (await api.get("/github/repos")).data;
export const disconnectGithub = async () => (await api.post("/github/disconnect")).data;

export const analyzeRepository = async ({ owner, repo, branch = "main" }) =>
  (await api.post("/github/analyze", { owner, repo, branch })).data;

export const createProject = async (projectData) => (await api.post("/projects", projectData)).data;
export const getProjects = async () => (await api.get("/projects")).data;
export const getProjectById = async (id) => (await api.get(`/projects/${id}`)).data;

export const getProjectPlan = async (id) => (await api.get(`/projects/${id}/plan`)).data;
export const generateProjectPlan = async (id) => (await api.post(`/projects/${id}/plan`)).data;
export const saveProjectEnvVars = async (id, envValues, ignoredEnv) => (await api.post(`/projects/${id}/env`, { envValues, ...(ignoredEnv ? { ignoredEnv } : {}) })).data;
export const scanProjectEnv = async (id) => (await api.post(`/projects/${id}/env/scan`)).data;

export const getProjectDockerConfig = async (id) => (await api.get(`/projects/${id}/docker`)).data;
export const updateProjectDockerStrategy = async (id, strategy) => (await api.post(`/projects/${id}/docker/strategy`, { strategy })).data;
export const validateDockerContent = async (id, content) => (await api.post(`/projects/${id}/docker/validate`, { content })).data;
export const saveProjectDockerFiles = async (id, dockerfile, dockerignore) => (await api.post(`/projects/${id}/docker/save`, { dockerfile, dockerignore })).data;

export const deleteProject = async (id) => (await api.delete(`/projects/${id}`)).data;
export const getProjectInfrastructure = async (id) => (await api.get(`/projects/${id}/infrastructure`)).data;

export const getAwsStatus = async () => (await api.get("/aws/status")).data;
export const initiateAwsSetup = async (region) => (await api.post("/aws/setup", { region })).data;
export const connectAwsRole = async ({ roleArn, region }) => (await api.post("/aws/connect", { roleArn, region })).data.connection;
export const saveAwsCredentials = async ({ accessKeyId, secretAccessKey, sessionToken, region }) => (await api.post("/aws/credentials", { accessKeyId, secretAccessKey, sessionToken, region })).data.connection;
export const disconnectAws = async () => (await api.post("/aws/disconnect")).data;

export const triggerProjectDeployment = async (projectId) => (await api.post(`/deployments/project/${projectId}`)).data;
export const retryDeployment = async (id) => (await api.post(`/deployments/${id}/retry`)).data;
export const rollbackDeployment = async (id, reason) => (await api.post(`/deployments/${id}/rollback`, { reason })).data;
export const getDeploymentQueuePosition = async (id) => (await api.get(`/deployments/${id}/queue-position`)).data;
export const destroyDeployment = async (id) => (await api.post(`/deployments/${id}/destroy`)).data;
export const destroyProjectInfrastructure = async (projectId) => (await api.post(`/deployments/project/${projectId}/destroy`)).data;
export const getDeploymentById = async (id) => (await api.get(`/deployments/${id}`)).data;
export const getProjectDeployments = async (projectId) => (await api.get(`/deployments/project/${projectId}`)).data;
export const updateProfile = async (profile) => (await api.patch("/auth/profile", profile)).data;

export async function streamDeploymentLogs(deploymentId, { onMessage, onError, signal } = {}) {
  const token = localStorage.getItem("token");
  const response = await fetch(`${api.defaults.baseURL}/deployments/${encodeURIComponent(deploymentId)}/logs/stream`, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: "include",
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`Log stream failed (${response.status})`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const data = frame.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
      if (!data) continue;
      try {
        onMessage?.(JSON.parse(data));
      } catch (parseError) {
        onError?.(parseError);
      }
    }
  }
}

export default api;

export const getProjectSecurity = async (id) => (await api.get(`/projects/${id}/security`)).data;
export const setProjectSecurityTier = async (id, tier) => (await api.post(`/projects/${id}/security/tier`, { tier })).data;
export const runProjectSecurityScan = async (id) => (await api.post(`/projects/${id}/security/scan`, undefined, { timeout: 240_000 })).data;
export const setUnderAttackMode = async (id, enabled) => (await api.post(`/projects/${id}/security/under-attack`, { enabled })).data;
export const unbanProjectIp = async (id, ip) => (await api.post(`/projects/${id}/security/unban`, { ip })).data;
export const createSecurityFixPullRequest = async (id, findingId) => (await api.post(`/projects/${id}/security/fix`, { findingId }, { timeout: 180_000 })).data;
export const takeSiteOffline = async (id) => (await api.post(`/projects/${id}/site/offline`)).data;
export const bringSiteOnline = async (id) => (await api.post(`/projects/${id}/site/online`)).data;
