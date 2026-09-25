"use client";

import { SERIES, DANGER_COLOR } from "@/shared/utils/chartColors";
import { recentActivity } from "@/shared/utils/logActivity";

const HEIGHT = 44;
// Stacked bottom-up: errors on top so they stand out.
const STACK = [
  { key: "debug", color: "var(--reddb-color-ink-muted)", opacity: 0.35 },
  { key: "info", color: SERIES.blue, opacity: 0.75 },
  { key: "warn", color: SERIES.amber, opacity: 0.9 },
  { key: "error", color: DANGER_COLOR, opacity: 1 },
];

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Stat({ label, value, tone }) {
  return (
    <div className="flex min-w-[4.5rem] flex-col">
      <span className="text-[10px] uppercase tracking-wide text-text-muted">{label}</span>
      <span className={`font-mono text-lg font-semibold tabular-nums leading-tight ${tone || "text-text-main"}`}>{value}</span>
    </div>
  );
}

/**
 * Events per minute as stacked bars (info, warn, error, debug), with the last
 * five minutes' rate beside it. Clicking a bar narrows the log to that minute.
 */
export default function LogActivity({ buckets, selected, onSelect }) {
  const peak = Math.max(1, ...buckets.map((b) => b.total));
  const recent = recentActivity(buckets, 5);
  const width = 100 / buckets.length;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-3 py-2.5">
      <div className="flex gap-5">
        <Stat label="lines / min" value={recent.perMinute} />
        <Stat label="warn · 5 min" value={recent.warn} tone={recent.warn ? "text-feedback-warning-foreground" : "text-text-muted"} />
        <Stat label="error · 5 min" value={recent.error} tone={recent.error ? "text-feedback-danger-foreground" : "text-text-muted"} />
      </div>

      <div className="min-w-[16rem] flex-1">
        <svg viewBox={`0 0 100 ${HEIGHT}`} preserveAspectRatio="none" className="block h-11 w-full" role="img" aria-label={`Log lines per minute, last ${buckets.length} minutes`}>
          {buckets.map((b, i) => {
            let y = HEIGHT;
            const isSelected = selected === b.start;
            return (
              <g key={b.start} onClick={() => onSelect(isSelected ? null : b.start)} className="cursor-pointer">
                <title>{`${clock(b.start)} · ${b.total} lines${b.error ? ` · ${b.error} errors` : ""}${b.warn ? ` · ${b.warn} warnings` : ""}`}</title>
                {/* Full-height hit area and selection highlight. */}
                <rect x={i * width} y={0} width={width} height={HEIGHT} fill={isSelected ? "var(--reddb-color-primary)" : "transparent"} opacity={isSelected ? 0.12 : 0} />
                {STACK.map(({ key, color, opacity }) => {
                  if (!b[key]) return null;
                  const h = Math.max(1, (b[key] / peak) * (HEIGHT - 4));
                  y -= h;
                  return <rect key={key} x={i * width + width * 0.12} y={y} width={width * 0.76} height={h} rx={0.4} fill={color} opacity={opacity} />;
                })}
              </g>
            );
          })}
        </svg>
        <div className="mt-0.5 flex justify-between font-mono text-[10px] text-text-muted">
          <span>{clock(buckets[0].start)}</span>
          <span>{selected ? `showing ${clock(selected)} · click again to clear` : "click a bar to see that minute"}</span>
          <span>now</span>
        </div>
      </div>
    </div>
  );
}
