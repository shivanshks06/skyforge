export function toPublicProject(project) {
  if (!project || typeof project !== "object") return project;
  const safe = { ...project };
  delete safe.envConfig;
  if (safe.databaseConfig) {
    const { password, ...database } = safe.databaseConfig;
    safe.databaseConfig = { ...database, hasPassword: Boolean(password) };
  }
  delete safe.dockerPath;
  delete safe.terraformPath;
  return safe;
}
