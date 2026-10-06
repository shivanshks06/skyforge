/** Maps a project status (and its latest deployment) to a StatusBadge state: live, working, failed, offline, destroyed or idle. */
export function projectState(project) {
  const status = String(project?.status || "").toLowerCase();
  const deployment = String(project?.latestDeployment?.status || "").toUpperCase();
  if (status === "offline") return "offline";
  if (/destroying/.test(status) || ["QUEUED", "BUILDING", "PUSHING", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "ROLLING_BACK", "DESTROYING"].includes(deployment)) return "working";
  if (status === "live" || status === "starting" || ["LIVE", "ROLLED_BACK"].includes(deployment)) return deployment === "DESTROYED" ? "destroyed" : "live";
  if (/fail/.test(status) || ["FAILED", "DESTROY_FAILED"].includes(deployment)) return "failed";
  if (/destroy/.test(status) || deployment === "DESTROYED") return "destroyed";
  return "idle";
}
