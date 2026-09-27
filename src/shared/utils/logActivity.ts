export const LOG_ACTIVITY_MINUTE_MS = 60_000;

export type LogActivityLevel = "debug" | "info" | "warn" | "error";

export interface LogActivityEntry {
  timestamp?: string | number | null;
  level?: string | null;
  msg?: string;
  message?: string;
}

export interface LogActivityBucket {
  start: number;
  debug: number;
  info: number;
  warn: number;
  error: number;
  total: number;
}

export function logActivityLevel(entry: LogActivityEntry): LogActivityLevel {
  const level = entry.level?.toLowerCase();
  if (level === "debug" || level === "trace") return "debug";
  if (level === "warn") return "warn";
  if (level === "error" || level === "fatal") return "error";
  const text = entry.msg ?? entry.message ?? "";
  if (/⚠️|\bWARN\b/.test(text)) return "warn";
  if (/❌|🔴|\bERROR\b|\bError:/.test(text)) return "error";
  return "info";
}

export function bucketLogActivity(
  entries: readonly LogActivityEntry[],
  now = Date.now(),
  minutes = 30
): LogActivityBucket[] {
  const count = Math.max(1, Math.min(120, Math.floor(minutes)));
  const end =
    Math.floor(now / LOG_ACTIVITY_MINUTE_MS) * LOG_ACTIVITY_MINUTE_MS + LOG_ACTIVITY_MINUTE_MS;
  const first = end - count * LOG_ACTIVITY_MINUTE_MS;
  const buckets: LogActivityBucket[] = Array.from({ length: count }, (_, index) => ({
    start: first + index * LOG_ACTIVITY_MINUTE_MS,
    debug: 0,
    info: 0,
    warn: 0,
    error: 0,
    total: 0,
  }));

  for (const entry of entries) {
    if (entry.timestamp === null || entry.timestamp === undefined) continue;
    const timestamp = new Date(entry.timestamp).getTime();
    if (!Number.isFinite(timestamp) || timestamp < first || timestamp >= end) continue;
    const bucket = buckets[Math.floor((timestamp - first) / LOG_ACTIVITY_MINUTE_MS)];
    bucket[logActivityLevel(entry)] += 1;
    bucket.total += 1;
  }
  return buckets;
}

export function recentLogActivity(buckets: readonly LogActivityBucket[], minutes = 5) {
  const recent = buckets.slice(-Math.max(1, Math.floor(minutes)));
  const total = recent.reduce((sum, bucket) => sum + bucket.total, 0);
  return {
    total,
    perMinute: recent.length ? Math.round((total / recent.length) * 10) / 10 : 0,
    warn: recent.reduce((sum, bucket) => sum + bucket.warn, 0),
    error: recent.reduce((sum, bucket) => sum + bucket.error, 0),
  };
}
