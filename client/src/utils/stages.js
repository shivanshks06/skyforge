// The deploy pipeline's stages in order, with a friendly name and colour, and helpers for their timings.
export const STAGES = [
  { key: "CLONING", label: "Download code", color: "#8C7667" },
  { key: "BUILDING", label: "Build", color: "#9E5D2D" },
  { key: "PUSHING", label: "Upload image", color: "#7C4DBA" },
  { key: "PROVISIONING", label: "Set up AWS", color: "#2563EB" },
  { key: "DEPLOYING", label: "Roll out", color: "#0E8A7A" },
  { key: "HEALTH_CHECK", label: "Health check", color: "#2E6B4F" },
];

export const stageInfo = (key) => STAGES.find((stage) => stage.key === key) || { key, label: String(key || "").toLowerCase().replaceAll("_", " "), color: "#A39284" };

/**
 * Durations per stage from the worker's [{ stage, at }] list. The last running stage counts up to `endAt`
 * (the completion time, or now while it's still going).
 */
export function stageDurations(timings = [], endAt = null) {
  const list = Array.isArray(timings) ? timings : [];
  const end = endAt ? new Date(endAt).getTime() : Date.now();
  return list
    .map((entry, index) => {
      const start = new Date(entry.at).getTime();
      const next = list[index + 1] ? new Date(list[index + 1].at).getTime() : end;
      return { stage: entry.stage, start, ms: Math.max(0, next - start) };
    })
    .filter((entry) => STAGES.some((stage) => stage.key === entry.stage));
}
