// Console Log activity: the level of each entry and entries per minute, for the
// sparkline above the log. Pure, so the page and its tests share it.

export const LOG_LEVELS = ["info", "warn", "error", "debug"];
export const MINUTE_MS = 60_000;

/** An entry's level; warnings and errors that reach console.log still read as what they are. */
export function levelOf(entry) {
  if (entry.level && entry.level !== "info" && LOG_LEVELS.includes(entry.level)) return entry.level;
  if (/⚠️|\bWARN\b/.test(entry.text)) return "warn";
  if (/❌|🔴|\bERROR\b|\bError:/.test(entry.text)) return "error";
  return "info";
}

/**
 * Entries per minute for the last `minutes` minutes up to `now`, oldest first:
 * [{ start, info, warn, error, debug, total }]. Entries without a time are left out.
 */
export function bucketByMinute(entries, { now = Date.now(), minutes = 30 } = {}) {
  const end = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const first = end - minutes * MINUTE_MS;
  const buckets = Array.from({ length: minutes }, (_, i) => ({ start: first + i * MINUTE_MS, info: 0, warn: 0, error: 0, debug: 0, total: 0 }));
  for (const entry of entries) {
    if (!entry.t || entry.t < first || entry.t >= end) continue;
    const bucket = buckets[Math.floor((entry.t - first) / MINUTE_MS)];
    bucket[levelOf(entry)] += 1;
    bucket.total += 1;
  }
  return buckets;
}

/** Totals over the last `minutes` buckets: { total, perMinute, warn, error }. */
export function recentActivity(buckets, minutes = 5) {
  const recent = buckets.slice(-minutes);
  const sum = (key) => recent.reduce((n, b) => n + b[key], 0);
  const total = sum("total");
  return { total, perMinute: recent.length ? Math.round((total / recent.length) * 10) / 10 : 0, warn: sum("warn"), error: sum("error") };
}
