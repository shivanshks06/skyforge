import { stageDurations, stageInfo } from "../utils/stages";
import { formatDuration } from "../utils/format";

/** A segmented bar: one coloured piece per pipeline stage, sized by how long it took. */
export default function StageBar({ timings, endAt, failedStage = null, showLegend = false, height = 8 }) {
  const durations = stageDurations(timings, endAt);
  const total = durations.reduce((sum, entry) => sum + entry.ms, 0);
  if (!durations.length || !total) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex w-full overflow-hidden rounded-full bg-[#F0E7DC]" style={{ height }}>
        {durations.map((entry) => {
          const info = stageInfo(entry.stage);
          const failed = failedStage && failedStage === entry.stage;
          return (
            <div
              key={`${entry.stage}-${entry.start}`}
              title={`${info.label}: ${formatDuration(entry.ms)}`}
              style={{ width: `${Math.max(2, (entry.ms / total) * 100)}%`, background: failed ? "#C2412D" : info.color }}
              className="h-full border-r border-white/40 last:border-r-0"
            />
          );
        })}
      </div>
      {showLegend && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[#8C7667]">
          {durations.map((entry) => {
            const info = stageInfo(entry.stage);
            return (
              <span key={`${entry.stage}-${entry.start}`} className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: failedStage === entry.stage ? "#C2412D" : info.color }} />
                {info.label} {formatDuration(entry.ms)}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
