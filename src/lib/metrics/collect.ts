/**
 * Gathers the data behind GET /api/metrics. Everything is computed at scrape time from existing
 * tables and in-process state — nothing on the request hot path is instrumented, and no metric
 * carries an API key, connection name, account or e-mail.
 */

import { APP_CONFIG } from "@/shared/constants/appConfig";
import { getAllCircuitBreakerStatuses } from "@/shared/utils/circuitBreaker";
import { getRawProviderConnections } from "@/lib/db/providers";
import {
  queryCostAggregates,
  queryUsageAggregates,
  type CostAggregateRow,
  type UsageAggregateRow,
} from "@/lib/db/metricsAggregates";
import {
  REQUEST_DURATION_BUCKETS_SECONDS,
  renderPrometheusText,
  type MetricsSnapshot,
} from "./prometheusText";

/** Cardinality cap: provider/model pairs beyond this many are folded into model="other". */
export const MAX_LABEL_PAIRS = 200;
export const OTHER_MODEL_LABEL = "other";
/** How long a computed aggregate is reused, so a fast scraper cannot hammer SQLite. */
export const AGGREGATE_CACHE_TTL_MS = 15_000;

/** Connection statuses that never recover by themselves (see AGENTS.md, Connection Cooldown). */
const TERMINAL_CONNECTION_STATUSES = new Set(["banned", "expired", "credits_exhausted"]);

type AggregateSnapshot = Pick<
  MetricsSnapshot,
  "requests" | "tokens" | "costUsd" | "latency" | "connections"
>;

let cached: { at: number; value: AggregateSnapshot } | null = null;

/** Drop the aggregate cache (tests, and after a database swap). */
export function resetMetricsCache(): void {
  cached = null;
}

interface Folded<T> {
  provider: string;
  model: string;
  data: T;
}

const pairKey = (provider: string, model: string) => `${provider}\u0000${model}`;

/**
 * Pick the MAX_LABEL_PAIRS busiest provider/model pairs (ties broken by name so the choice is
 * stable between scrapes) and return a mapper that folds every other pair to
 * `{provider, model: "other"}`. Folding keeps the provider (a small, bounded set) and only drops
 * the unbounded model dimension, so per-provider totals stay exact.
 */
export function buildLabelFolder(
  usage: UsageAggregateRow[],
  maxPairs = MAX_LABEL_PAIRS
): (provider: string, model: string) => { provider: string; model: string } {
  const totals = new Map<string, { provider: string; model: string; requests: number }>();
  for (const row of usage) {
    const key = pairKey(row.provider, row.model);
    const entry = totals.get(key) ?? { provider: row.provider, model: row.model, requests: 0 };
    entry.requests += row.requests;
    totals.set(key, entry);
  }
  const ranked = [...totals.values()].sort(
    (a, b) =>
      b.requests - a.requests || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)
  );
  const kept = new Set(ranked.slice(0, maxPairs).map((e) => pairKey(e.provider, e.model)));
  return (provider, model) =>
    kept.has(pairKey(provider, model)) ? { provider, model } : { provider, model: OTHER_MODEL_LABEL };
}

function sumInto<T>(
  map: Map<string, Folded<T>>,
  provider: string,
  model: string,
  create: () => T,
  add: (target: T) => void
): void {
  const key = pairKey(provider, model);
  let entry = map.get(key);
  if (!entry) {
    entry = { provider, model, data: create() };
    map.set(key, entry);
  }
  add(entry.data);
}

/** Pure: fold raw aggregate rows into the label-capped snapshot sections. */
export function foldAggregates(
  usage: UsageAggregateRow[],
  cost: CostAggregateRow[],
  maxPairs = MAX_LABEL_PAIRS
): Pick<MetricsSnapshot, "requests" | "tokens" | "costUsd" | "latency"> {
  const fold = buildLabelFolder(usage, maxPairs);
  const bucketCount = REQUEST_DURATION_BUCKETS_SECONDS.length;

  const requests = new Map<string, Folded<{ statusClass: string; count: number }>>();
  const tokens = new Map<
    string,
    Folded<{ input: number; output: number; cacheRead: number; cacheWrite: number }>
  >();
  const latency = new Map<
    string,
    Folded<{ buckets: number[]; sumMs: number; count: number }>
  >();
  const costs = new Map<string, Folded<{ value: number }>>();

  for (const row of usage) {
    const target = fold(row.provider, row.model);
    const reqKey = `${row.statusClass}\u0001${target.model}`;
    const reqEntry = requests.get(pairKey(target.provider, reqKey));
    if (reqEntry) reqEntry.data.count += row.requests;
    else
      requests.set(pairKey(target.provider, reqKey), {
        provider: target.provider,
        model: target.model,
        data: { statusClass: row.statusClass, count: row.requests },
      });

    sumInto(
      tokens,
      target.provider,
      target.model,
      () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      (t) => {
        t.input += row.tokensInput;
        t.output += row.tokensOutput;
        t.cacheRead += row.tokensCacheRead;
        t.cacheWrite += row.tokensCacheWrite;
      }
    );
    sumInto(
      latency,
      target.provider,
      target.model,
      () => ({ buckets: new Array<number>(bucketCount).fill(0), sumMs: 0, count: 0 }),
      (l) => {
        l.count += row.requests;
        l.sumMs += row.latencyMsSum;
        for (let i = 0; i < bucketCount; i++) l.buckets[i] += row.latencyBuckets[i] ?? 0;
      }
    );
  }

  for (const row of cost) {
    const target = fold(row.provider, row.model);
    sumInto(
      costs,
      target.provider,
      target.model,
      () => ({ value: 0 }),
      (c) => {
        c.value += row.costUsd;
      }
    );
  }

  const byLabels = <T extends { provider: string; model: string }>(a: T, b: T) =>
    a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);

  const requestRows = [...requests.values()]
    .map((e) => ({
      provider: e.provider,
      model: e.model,
      statusClass: e.data.statusClass,
      count: e.data.count,
    }))
    .sort((a, b) => byLabels(a, b) || a.statusClass.localeCompare(b.statusClass));

  const tokenRows = [...tokens.values()]
    .sort(byLabels)
    .flatMap((e) => [
      { provider: e.provider, model: e.model, direction: "input" as const, count: e.data.input },
      { provider: e.provider, model: e.model, direction: "output" as const, count: e.data.output },
      {
        provider: e.provider,
        model: e.model,
        direction: "cache_read" as const,
        count: e.data.cacheRead,
      },
      {
        provider: e.provider,
        model: e.model,
        direction: "cache_write" as const,
        count: e.data.cacheWrite,
      },
    ]);

  return {
    requests: requestRows,
    tokens: tokenRows,
    costUsd: [...costs.values()]
      .sort(byLabels)
      .map((e) => ({ provider: e.provider, model: e.model, value: e.data.value })),
    latency: [...latency.values()].sort(byLabels).map((e) => ({
      provider: e.provider,
      model: e.model,
      buckets: e.data.buckets,
      sumSeconds: e.data.sumMs / 1000,
      count: e.data.count,
    })),
  };
}

async function collectConnectionCounts(now: number): Promise<MetricsSnapshot["connections"]> {
  const counts = new Map<string, number>();
  try {
    const rows = (await getRawProviderConnections({}, undefined, undefined, [
      "provider",
      "is_active",
      "test_status",
      "rate_limited_until",
    ])) as Record<string, unknown>[];
    for (const row of rows) {
      const provider = typeof row.provider === "string" && row.provider ? row.provider : "unknown";
      let status: "active" | "unavailable" | "disabled";
      if (row.isActive === false || row.isActive === 0) {
        status = "disabled";
      } else {
        const testStatus = typeof row.testStatus === "string" ? row.testStatus : "";
        const until =
          typeof row.rateLimitedUntil === "string" ? new Date(row.rateLimitedUntil).getTime() : 0;
        status =
          TERMINAL_CONNECTION_STATUSES.has(testStatus) || (Number.isFinite(until) && until > now)
            ? "unavailable"
            : "active";
      }
      const key = `${provider}\u0000${status}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  } catch {
    return [];
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [provider, status] = key.split("\u0000");
      return { provider, status, count };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.status.localeCompare(b.status));
}

/** Provider-level breakers only; per-connection breakers (`<provider>::conn::<id>`) are skipped. */
export function collectBreakerStates(): MetricsSnapshot["breakers"] {
  try {
    return getAllCircuitBreakerStatuses()
      .filter((status) => status.name && !status.name.includes("::"))
      .map((status) => ({ provider: status.name, state: String(status.state) }))
      .sort((a, b) => a.provider.localeCompare(b.provider));
  } catch {
    return [];
  }
}

export interface CollectOptions {
  /** Override the clock (tests). */
  now?: number;
  /** Override the aggregate cache TTL (tests). */
  cacheTtlMs?: number;
}

export async function collectMetrics(options: CollectOptions = {}): Promise<MetricsSnapshot> {
  const now = options.now ?? Date.now();
  const ttl = options.cacheTtlMs ?? AGGREGATE_CACHE_TTL_MS;

  if (!cached || now - cached.at >= ttl || now < cached.at) {
    const folded = foldAggregates(queryUsageAggregates(), queryCostAggregates());
    cached = {
      at: now,
      value: { ...folded, connections: await collectConnectionCounts(now) },
    };
  }

  return {
    ...cached.value,
    // Breaker state and uptime are cheap and in-process: always live, never cached.
    breakers: collectBreakerStates(),
    version: String(APP_CONFIG.version ?? "unknown"),
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

export async function renderMetrics(options: CollectOptions = {}): Promise<string> {
  return renderPrometheusText(await collectMetrics(options));
}
