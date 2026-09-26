export function toPublicProject(project) {
  if (!project || typeof project !== "object") return project;
  const safe = { ...project };
  delete safe.envConfig;
  delete safe.dockerPath;
  delete safe.terraformPath;
  return safe;
}
