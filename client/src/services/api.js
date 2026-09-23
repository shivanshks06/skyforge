import axios from "axios";

const api = axios.create({
  baseURL: "http://localhost:5000/api",
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

export const getGithubRepos = async () => {
  const response = await api.get("/github/repos");
  return response.data;
};

export const analyzeRepository = async ({ owner, repo, branch = "main" }) => {
  const response = await api.post("/github/analyze", { owner, repo, branch });
  return response.data;
};

export const createProject = async (projectData) => {
  const response = await api.post("/projects", projectData);
  return response.data;
};

export const getProjects = async () => {
  const response = await api.get("/projects");
  return response.data;
};

export default api;