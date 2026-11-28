import { useEffect, useState } from "react";
import { rustAdminFetch } from "./api/browserClient";

const DAY_MS = 24 * 60 * 60 * 1_000;

function utcDate(unixMs: number): string {
  return new Date(unixMs).toISOString().slice(0, 10);
}

/** Days in a row up to today (UTC) with tokens (legacy computeActivityStreak). */
function activityStreak(activity: Record<string, number>, today: number): number {
  let streak = 0;
  while ((activity[utcDate(today - streak * DAY_MS)] ?? 0) > 0) streak += 1;
  return streak;
}

function intensity(value: number, max: number): string {
  if (value === 0) return "bg-surface";
  const ratio = value / max;
  if (ratio < 0.25) return "bg-emerald-900/50";
  if (ratio < 0.5) return "bg-emerald-700/60";
  if (ratio < 0.75) return "bg-emerald-500/70";
  return "bg-emerald-400";
}

/** Tokens per UTC day over the last year (legacy usage activity heatmap). */
export default function ActivityHeatmap({ keyId, until }: { keyId: string; until: number }) {
  const requestKey = `${keyId}|${until}`;
  const [result, setResult] = useState<{
    key: string;
    activity: Record<string, number> | null;
    error: string;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const key = `${keyId}|${until}`;
    const query = new URLSearchParams({
      by: "day",
      from_unix_ms: String(until - 365 * DAY_MS),
      to_unix_ms: String(until),
    });
    if (keyId) query.set("key_id", keyId);
    rustAdminFetch(`/api/admin/usage/breakdown?${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Activity unavailable (${response.status})`);
        const data = await response.json();
        const groups: unknown = data?.breakdown?.groups;
        if (!Array.isArray(groups)) throw new Error("Invalid activity");
        const activity: Record<string, number> = {};
        for (const group of groups as Array<Record<string, unknown>>) {
          if (typeof group.group === "string")
            activity[group.group] =
              Number(group.tokens_input ?? 0) + Number(group.tokens_output ?? 0);
        }
        setResult({ key, activity, error: "" });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setResult({
            key,
            activity: null,
            error: cause instanceof Error ? cause.message : "Activity unavailable",
          });
      });
    return () => controller.abort();
  }, [keyId, until]);

  const current = result?.key === requestKey ? result : null;
  if (current?.error) return <p className="text-error">{current.error}</p>;
  const activity = current?.activity;
  if (!activity) return <p>Loading activity…</p>;
  const today = until - 1;
  const days = Array.from({ length: 365 }, (_, index) => {
    const date = utcDate(today - (364 - index) * DAY_MS);
    return { date, value: activity[date] ?? 0 };
  });
  const max = Math.max(...days.map((day) => day.value), 1);
  const weeks: Array<typeof days> = [];
  for (let index = 0; index < days.length; index += 7) weeks.push(days.slice(index, index + 7));
  const streak = activityStreak(activity, today);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        Tokens per day over the last year (UTC) · {streak} day{streak === 1 ? "" : "s"} in a row
      </p>
      <div className="overflow-x-auto">
        <div className="flex gap-0.5">
          {weeks.map((week) => (
            <div key={week[0].date} className="flex flex-col gap-0.5">
              {week.map((day) => (
                <div
                  key={day.date}
                  className={`h-2.5 w-2.5 rounded-sm border border-border ${intensity(day.value, max)}`}
                  title={`${day.date}: ${
                    day.value > 0 ? `${day.value.toLocaleString()} tokens` : "No activity"
                  }`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
