/**
 * In-memory health of each (account, model) pair, fed by finished requests:
 * EWMA of time-to-first-token and total latency plus an EWMA error rate, and a
 * circuit breaker (3 consecutive failures open it for 30 s, doubling per failed
 * trial, max 5 min). The `health` account-fallback strategy uses it to order
 * accounts. Per process and never persisted: after a restart every pair is
 * untried.
 *
 * Ported from the `feat/account-health` concept (providerHealth.js). The
 * concept's (provider, model) aggregate + combo-member demotion were NOT
 * ported: the base already skips combo targets whose provider/connection
 * breaker is OPEN, whose model is locked or whose quota is cut
 * (open-sse/services/combo/executeTargetGates.ts), which supersedes demoting
 * them to the back of the chain.
 */

const ALPHA = 0.3;
const BREAKER_THRESHOLD = 3; // consecutive failures that open the breaker
const BREAKER_BASE_MS = 30_000; // first open period; doubles per reopen
const BREAKER_MAX_MS = 5 * 60_000;
const ERROR_RATE_STEP = 0.1; // error rates closer than this rank as equal
const TTFT_TOLERANCE = 1.25; // TTFTs within 25% of each other rank as equal
const MAX_ENTRIES = 5000;

export interface ProviderHealthEntry {
  samples: number;
  ttftMs: number | null;
  latencyMs: number | null;
  errorRate: number;
  consecutiveFailures: number;
  openUntil: number;
  openMs: number;
  lastAt: number;
}

export type ProviderHealthBreakerState = "closed" | "open" | "half-open";

interface ProviderHealthState {
  entries: Map<string, ProviderHealthEntry>;
}

const globalWithStore = globalThis as typeof globalThis & {
  __omnirouteProviderHealth?: ProviderHealthState;
};
const state: ProviderHealthState = (globalWithStore.__omnirouteProviderHealth ??= {
  entries: new Map<string, ProviderHealthEntry>(),
});

const keyOf = (connectionId: string, model: string | null | undefined): string =>
  `${connectionId}\u0000${model || "*"}`;

function entryFor(connectionId: string, model: string | null | undefined): ProviderHealthEntry {
  const key = keyOf(connectionId, model);
  let entry = state.entries.get(key);
  if (!entry) {
    if (state.entries.size >= MAX_ENTRIES) {
      state.entries.delete(state.entries.keys().next().value as string);
    }
    entry = {
      samples: 0,
      ttftMs: null,
      latencyMs: null,
      errorRate: 0,
      consecutiveFailures: 0,
      openUntil: 0,
      openMs: 0,
      lastAt: 0,
    };
    state.entries.set(key, entry);
  }
  return entry;
}

const ewma = (prev: number | null, value: number): number =>
  prev === null ? value : prev + ALPHA * (value - prev);

function applySuccess(
  entry: ProviderHealthEntry,
  ttftMs: number | null,
  latencyMs: number | null,
  now: number
): void {
  entry.samples += 1;
  if (ttftMs !== null && Number.isFinite(ttftMs) && ttftMs >= 0)
    entry.ttftMs = ewma(entry.ttftMs, ttftMs);
  if (latencyMs !== null && Number.isFinite(latencyMs) && latencyMs >= 0) {
    entry.latencyMs = ewma(entry.latencyMs, latencyMs);
  }
  entry.errorRate = ewma(entry.errorRate, 0);
  entry.consecutiveFailures = 0;
  entry.openUntil = 0;
  entry.openMs = 0;
  entry.lastAt = now;
}

function applyFailure(entry: ProviderHealthEntry, now: number): void {
  entry.samples += 1;
  entry.errorRate = ewma(entry.errorRate, 1);
  entry.consecutiveFailures += 1;
  entry.lastAt = now;
  if (entry.consecutiveFailures >= BREAKER_THRESHOLD) {
    // A failed half-open trial reopens for twice as long.
    entry.openMs = entry.openMs ? Math.min(entry.openMs * 2, BREAKER_MAX_MS) : BREAKER_BASE_MS;
    entry.openUntil = now + entry.openMs;
  }
}

export interface ProviderHealthSample {
  connectionId: string;
  model?: string | null;
  ttftMs?: number | null;
  latencyMs?: number | null;
}

/** A request on this account/model answered. */
export function recordSuccess(
  { connectionId, model = null, ttftMs = null, latencyMs = null }: ProviderHealthSample,
  now = Date.now()
): void {
  if (!connectionId || connectionId === "noauth") return;
  applySuccess(entryFor(connectionId, model), ttftMs, latencyMs, now);
}

/** A request on this account/model failed in a way that says something about the account. */
export function recordFailure(
  { connectionId, model = null }: ProviderHealthSample,
  now = Date.now()
): void {
  if (!connectionId || connectionId === "noauth") return;
  applyFailure(entryFor(connectionId, model), now);
}

/** "closed" (healthy), "open" (failing, cooling down) or "half-open" (cooldown over, next request is a trial). */
export function breakerState(
  entry: ProviderHealthEntry | null | undefined,
  now = Date.now()
): ProviderHealthBreakerState {
  if (!entry?.openMs) return "closed";
  return entry.openUntil > now ? "open" : "half-open";
}

export interface HealthSnapshot {
  samples: number;
  ttftMs: number | null;
  latencyMs: number | null;
  errorRate: number;
  breaker: ProviderHealthBreakerState;
  lastAt: number;
}

export function getHealth(
  connectionId: string,
  model: string | null = null,
  now = Date.now()
): HealthSnapshot | null {
  const entry = state.entries.get(keyOf(connectionId, model));
  if (!entry) return null;
  return {
    samples: entry.samples,
    ttftMs: entry.ttftMs === null ? null : Math.round(entry.ttftMs),
    latencyMs: entry.latencyMs === null ? null : Math.round(entry.latencyMs),
    errorRate: Math.round(entry.errorRate * 1000) / 1000,
    breaker: breakerState(entry, now),
    lastAt: entry.lastAt,
  };
}

const BREAKER_RANK: Record<ProviderHealthBreakerState, number> = {
  closed: 0,
  "half-open": 1,
  open: 2,
};

/**
 * Accounts ordered best first for a model: untried accounts first (so each gets
 * measured), then by breaker, error rate and time to first token. Ties keep the
 * input order (the configured priority). With probability `explore`, the first
 * healthy account swaps with a random other healthy one so a slow account that
 * recovered can be noticed; `random` is injectable for tests.
 */
export function rankByHealth<T extends { id: string }>(
  connections: readonly T[],
  model: string | null = null,
  {
    now = Date.now(),
    explore = 0,
    random = Math.random,
  }: { now?: number; explore?: number; random?: () => number } = {}
): T[] {
  const scored = connections.map((conn, index) => {
    const entry = state.entries.get(keyOf(conn.id, model));
    const ttft = entry?.ttftMs ?? entry?.latencyMs ?? null;
    return {
      conn,
      index,
      untried: !entry || entry.samples === 0,
      breaker: BREAKER_RANK[breakerState(entry, now)],
      errorBucket: entry ? Math.round(entry.errorRate / ERROR_RATE_STEP) : 0,
      ttft,
    };
  });
  const measured: number[] = [];
  for (const s of scored) if (s.ttft !== null) measured.push(s.ttft);
  const fastest = measured.length ? Math.min(...measured) : null;
  const ttftBucket = (t: number | null): number =>
    t === null || !fastest
      ? 0
      : Math.floor(Math.log(Math.max(t, 1) / Math.max(fastest, 1)) / Math.log(TTFT_TOLERANCE));
  scored.sort(
    (a, b) =>
      (b.untried ? 1 : 0) - (a.untried ? 1 : 0) ||
      a.breaker - b.breaker ||
      a.errorBucket - b.errorBucket ||
      ttftBucket(a.ttft) - ttftBucket(b.ttft) ||
      a.index - b.index
  );
  const ranked = scored.map((s) => s.conn);
  if (explore > 0 && ranked.length > 1 && random() < explore) {
    const healthy = scored.filter((s) => s.breaker === 0).length;
    if (healthy > 1) {
      const pick = 1 + Math.floor(random() * (healthy - 1));
      [ranked[0], ranked[pick]] = [ranked[pick], ranked[0]];
    }
  }
  return ranked;
}

/** Test hook. */
export function resetProviderHealth(): void {
  state.entries.clear();
}
