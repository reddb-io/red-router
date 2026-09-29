/**
 * Prometheus text exposition format v0.0.4 renderer. Pure: takes plain data, returns text.
 * https://prometheus.io/docs/instrumenting/exposition_formats/#text-format-details
 */

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Histogram upper bounds in seconds; `+Inf` is appended by the renderer. */
export const REQUEST_DURATION_BUCKETS_SECONDS = [
  0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120,
] as const;

export const CIRCUIT_BREAKER_STATES = ["CLOSED", "DEGRADED", "OPEN", "HALF_OPEN"] as const;

export interface MetricsSnapshot {
  requests: { provider: string; model: string; statusClass: string; count: number }[];
  tokens: {
    provider: string;
    model: string;
    direction: "input" | "output" | "cache_read" | "cache_write";
    count: number;
  }[];
  costUsd: { provider: string; model: string; value: number }[];
  /** `buckets[i]` is the cumulative count for REQUEST_DURATION_BUCKETS_SECONDS[i]. */
  latency: {
    provider: string;
    model: string;
    buckets: number[];
    sumSeconds: number;
    count: number;
  }[];
  breakers: { provider: string; state: string }[];
  connections: { provider: string; status: string; count: number }[];
  version: string;
  uptimeSeconds: number;
}

/** Label values: backslash, double quote and newline are escaped. */
export function escapeLabelValue(value: string): string {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** HELP text: backslash and newline are escaped (quotes are not). */
export function escapeHelp(value: string): string {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

export function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  return String(value);
}

function labels(pairs: [string, string][]): string {
  if (pairs.length === 0) return "";
  return `{${pairs.map(([name, value]) => `${name}="${escapeLabelValue(value)}"`).join(",")}}`;
}

function header(lines: string[], name: string, type: string, help: string): void {
  lines.push(`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} ${type}`);
}

function sample(
  lines: string[],
  name: string,
  pairs: [string, string][],
  value: number
): void {
  lines.push(`${name}${labels(pairs)} ${formatValue(value)}`);
}

/** Render a snapshot. Every family is always emitted (HELP + TYPE), even when it has no samples. */
export function renderPrometheusText(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];

  header(
    lines,
    "redrouter_requests_total",
    "counter",
    "Completed requests by provider, model and HTTP status class."
  );
  for (const row of snapshot.requests) {
    sample(
      lines,
      "redrouter_requests_total",
      [
        ["provider", row.provider],
        ["model", row.model],
        ["status_class", row.statusClass],
      ],
      row.count
    );
  }

  header(
    lines,
    "redrouter_tokens_total",
    "counter",
    "Tokens processed by provider, model and direction (input, output, cache_read, cache_write)."
  );
  for (const row of snapshot.tokens) {
    sample(
      lines,
      "redrouter_tokens_total",
      [
        ["provider", row.provider],
        ["model", row.model],
        ["direction", row.direction],
      ],
      row.count
    );
  }

  header(
    lines,
    "redrouter_cost_usd_total",
    "counter",
    "Priced request cost in US dollars by provider and model."
  );
  for (const row of snapshot.costUsd) {
    sample(
      lines,
      "redrouter_cost_usd_total",
      [
        ["provider", row.provider],
        ["model", row.model],
      ],
      row.value
    );
  }

  header(
    lines,
    "redrouter_request_duration_seconds",
    "histogram",
    "Request duration in seconds by provider and model."
  );
  for (const row of snapshot.latency) {
    const base: [string, string][] = [
      ["provider", row.provider],
      ["model", row.model],
    ];
    REQUEST_DURATION_BUCKETS_SECONDS.forEach((bound, index) => {
      sample(
        lines,
        "redrouter_request_duration_seconds_bucket",
        [...base, ["le", String(bound)]],
        row.buckets[index] ?? 0
      );
    });
    sample(lines, "redrouter_request_duration_seconds_bucket", [...base, ["le", "+Inf"]], row.count);
    sample(lines, "redrouter_request_duration_seconds_sum", base, row.sumSeconds);
    sample(lines, "redrouter_request_duration_seconds_count", base, row.count);
  }

  header(
    lines,
    "redrouter_circuit_breaker_state",
    "gauge",
    "Provider circuit breaker state: 1 for the current state, 0 for the others."
  );
  for (const row of snapshot.breakers) {
    for (const state of CIRCUIT_BREAKER_STATES) {
      sample(
        lines,
        "redrouter_circuit_breaker_state",
        [
          ["provider", row.provider],
          ["state", state],
        ],
        row.state === state ? 1 : 0
      );
    }
  }

  header(
    lines,
    "redrouter_connections",
    "gauge",
    "Provider connections by provider and status (active, unavailable, disabled)."
  );
  for (const row of snapshot.connections) {
    sample(
      lines,
      "redrouter_connections",
      [
        ["provider", row.provider],
        ["status", row.status],
      ],
      row.count
    );
  }

  header(lines, "redrouter_build_info", "gauge", "Build information; the value is always 1.");
  sample(lines, "redrouter_build_info", [["version", snapshot.version]], 1);

  header(lines, "redrouter_uptime_seconds", "gauge", "Seconds since the server process started.");
  sample(lines, "redrouter_uptime_seconds", [], snapshot.uptimeSeconds);

  return `${lines.join("\n")}\n`;
}
