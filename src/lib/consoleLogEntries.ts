import { matchesSearch } from "@/shared/utils/turkishText";

const LEVEL_ORDER: Record<string, number> = {
  trace: 5,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

const NUMERIC_LEVEL_MAP: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

export interface ConsoleLogFilter {
  level?: string;
  component?: string;
  since?: number;
}

export interface ConsoleLogEntry extends Record<string, unknown> {
  level: string;
  msg: string;
  message: string;
  timestamp?: string | number;
}

function stringifyLogValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : String(value);
  } catch {
    return String(value);
  }
}

function parseLevel(raw: unknown): string {
  if (typeof raw === "number") return NUMERIC_LEVEL_MAP[raw] || "info";
  return String(raw ?? "info").toLowerCase();
}

export function parseConsoleLogLine(
  line: string,
  filter: ConsoleLogFilter
): ConsoleLogEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const entry = parsed as ConsoleLogEntry;
  const timestamp = entry.time ?? entry.timestamp;
  if (timestamp !== undefined && timestamp !== null && timestamp !== "") {
    const time =
      typeof timestamp === "number"
        ? new Date(timestamp).getTime()
        : new Date(String(timestamp)).getTime();
    if (filter.since !== undefined && time < filter.since) return null;
  }

  entry.level = parseLevel(entry.level);
  entry.msg = stringifyLogValue(entry.msg ?? entry.message ?? "");
  entry.message = stringifyLogValue(entry.message ?? entry.msg);
  if (entry.component !== undefined) entry.component = stringifyLogValue(entry.component);
  if (entry.module !== undefined) entry.module = stringifyLogValue(entry.module);
  if (entry.correlationId !== undefined) {
    entry.correlationId = stringifyLogValue(entry.correlationId);
  }

  const minLevel = LEVEL_ORDER[filter.level || "all"] || 0;
  if (minLevel > 0 && (LEVEL_ORDER[entry.level] || 0) < minLevel) return null;
  if (filter.component) {
    const component = String(entry.component || entry.module || "");
    if (!matchesSearch(component, filter.component)) return null;
  }

  if (entry.time && !entry.timestamp) {
    entry.timestamp = typeof entry.time === "number" ? entry.time : String(entry.time);
  }
  return entry;
}
