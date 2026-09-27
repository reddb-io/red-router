"use client";

import type { LogActivityBucket } from "@/shared/utils/logActivity";
import { recentLogActivity } from "@/shared/utils/logActivity";

interface ConsoleLogActivityProps {
  buckets: readonly LogActivityBucket[];
  selectedMinute: number | null;
  onSelectMinute: (minute: number | null) => void;
  locale: string;
  warningLabel: string;
  errorLabel: string;
}

const LEVEL_SEGMENTS = [
  { key: "debug", color: "bg-gray-500/70" },
  { key: "info", color: "bg-cyan-400/80" },
  { key: "warn", color: "bg-yellow-400/90" },
  { key: "error", color: "bg-red-400" },
] as const;

export default function ConsoleLogActivity({
  buckets,
  selectedMinute,
  onSelectMinute,
  locale,
  warningLabel,
  errorLabel,
}: ConsoleLogActivityProps) {
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.total));
  const recent = recentLogActivity(buckets);
  const clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 sm:flex-row sm:items-end sm:gap-5">
      <div className="flex shrink-0 gap-4 text-xs tabular-nums">
        <div>
          <span className="block text-[var(--color-text-muted)]">Lines / min</span>
          <span className="font-mono text-base font-semibold text-[var(--color-text-main)]">
            {recent.perMinute}
          </span>
        </div>
        <div>
          <span className="block text-[var(--color-text-muted)]">{warningLabel} · 5 min</span>
          <span className="font-mono text-base font-semibold text-yellow-400">{recent.warn}</span>
        </div>
        <div>
          <span className="block text-[var(--color-text-muted)]">{errorLabel} · 5 min</span>
          <span className="font-mono text-base font-semibold text-red-400">{recent.error}</span>
        </div>
      </div>
      <div
        className="flex h-12 min-w-0 flex-1 items-end gap-px"
        role="group"
        aria-label="Log lines per minute"
      >
        {buckets.map((bucket) => {
          const time = clock.format(bucket.start);
          const selected = selectedMinute === bucket.start;
          return (
            <button
              key={bucket.start}
              type="button"
              title={`${time}: ${bucket.total} lines, ${bucket.warn} ${warningLabel}, ${bucket.error} ${errorLabel}`}
              aria-label={`${time}: ${bucket.total} lines`}
              aria-pressed={selected}
              onClick={() => onSelectMinute(selected ? null : bucket.start)}
              className={`flex h-full min-w-0 flex-1 items-end rounded-sm focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${
                selected ? "bg-cyan-500/15" : "hover:bg-[var(--color-bg-alt)]"
              }`}
            >
              <span
                className="flex w-full flex-col-reverse overflow-hidden rounded-sm"
                style={{
                  height: `${Math.max(bucket.total ? 2 : 1, (bucket.total / peak) * 44)}px`,
                }}
                aria-hidden="true"
              >
                {LEVEL_SEGMENTS.map(({ key, color }) =>
                  bucket[key] > 0 ? (
                    <span key={key} className={color} style={{ flexGrow: bucket[key] }} />
                  ) : null
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
