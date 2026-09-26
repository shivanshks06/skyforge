export function toPublicDeployment(deployment) {
  if (!deployment || typeof deployment !== "object") return deployment;
  const safe = { ...deployment };
  delete safe.artifactPath;
  delete safe.workerJobId;
  delete safe.rollbackOriginalStatus;
  delete safe.resources;
  delete safe.teardownResources;
  delete safe.teardownDeploymentIds;
  return safe;
}
