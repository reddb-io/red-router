// In-memory health of each (account, model) pair, fed by finished requests:
// EWMA of time-to-first-token and total latency, an EWMA error rate, and a
// circuit breaker. Used to order accounts (the `health` strategy) and to push
// combo members whose every account is failing to the back of the chain.
// Per process and never persisted: after a restart every pair is untried.

const ALPHA = 0.3;
const BREAKER_THRESHOLD = 3;          // consecutive failures that open the breaker
const BREAKER_BASE_MS = 30_000;       // first open period; doubles per reopen
const BREAKER_MAX_MS = 5 * 60_000;
const ERROR_RATE_STEP = 0.1;          // error rates closer than this rank as equal
const TTFT_TOLERANCE = 1.25;          // TTFTs within 25% of each other rank as equal
const MAX_ENTRIES = 5000;

const state = globalThis.__rrProviderHealth ??= { entries: new Map() };

const keyOf = (connectionId, model) => `${connectionId}\u0000${model || "*"}`;

function entryFor(connectionId, model) {
  const key = keyOf(connectionId, model);
  let entry = state.entries.get(key);
  if (!entry) {
    if (state.entries.size >= MAX_ENTRIES) state.entries.delete(state.entries.keys().next().value);
    entry = { samples: 0, ttftMs: null, latencyMs: null, errorRate: 0, consecutiveFailures: 0, openUntil: 0, openMs: 0, lastAt: 0 };
    state.entries.set(key, entry);
  }
  return entry;
}

const ewma = (prev, value) => (prev === null ? value : prev + ALPHA * (value - prev));

// Every account of a provider also feeds one aggregate entry per model, which
// combos read: a member is only demoted when its provider is failing as a whole.
const providerKey = (provider) => `@${provider}`;

function applySuccess(entry, ttftMs, latencyMs, now) {
  entry.samples += 1;
  if (Number.isFinite(ttftMs) && ttftMs >= 0) entry.ttftMs = ewma(entry.ttftMs, ttftMs);
  if (Number.isFinite(latencyMs) && latencyMs >= 0) entry.latencyMs = ewma(entry.latencyMs, latencyMs);
  entry.errorRate = ewma(entry.errorRate, 0);
  entry.consecutiveFailures = 0;
  entry.openUntil = 0;
  entry.openMs = 0;
  entry.lastAt = now;
}

function applyFailure(entry, now) {
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

/** A request on this account/model answered. */
export function recordSuccess({ provider = null, connectionId, model = null, ttftMs = null, latencyMs = null, now = Date.now() }) {
  if (!connectionId || connectionId === "noauth") return;
  applySuccess(entryFor(connectionId, model), ttftMs, latencyMs, now);
  if (provider) applySuccess(entryFor(providerKey(provider), model), ttftMs, latencyMs, now);
}

/** A request on this account/model failed upstream in a way that says something about the account. */
export function recordFailure({ provider = null, connectionId, model = null, now = Date.now() }) {
  if (!connectionId || connectionId === "noauth") return;
  applyFailure(entryFor(connectionId, model), now);
  if (provider) applyFailure(entryFor(providerKey(provider), model), now);
}

/** Whether a provider/model is failing across its accounts (its aggregate breaker is open). */
export function isProviderModelOpen(provider, model, now = Date.now()) {
  return breakerState(state.entries.get(keyOf(providerKey(provider), model)), now) === "open";
}

/** "closed" (healthy), "open" (failing, cooling down) or "half-open" (cooldown over, next request is a trial). */
export function breakerState(entry, now = Date.now()) {
  if (!entry?.openMs) return "closed";
  return entry.openUntil > now ? "open" : "half-open";
}

export function getHealth(connectionId, model = null, now = Date.now()) {
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

const BREAKER_RANK = { closed: 0, "half-open": 1, open: 2 };

/**
 * One account across all its models, for the dashboard: request count, TTFT and
 * error rate averaged by samples, and how many models have an open breaker.
 */
export function summarizeConnectionHealth(connectionId, now = Date.now()) {
  const prefix = `${connectionId}\u0000`;
  let samples = 0, ttftWeighted = 0, ttftSamples = 0, errorWeighted = 0, openModels = 0, lastAt = 0;
  for (const [key, entry] of state.entries) {
    if (!key.startsWith(prefix) || !entry.samples) continue;
    samples += entry.samples;
    errorWeighted += entry.errorRate * entry.samples;
    if (entry.ttftMs !== null) { ttftWeighted += entry.ttftMs * entry.samples; ttftSamples += entry.samples; }
    if (breakerState(entry, now) === "open") openModels += 1;
    lastAt = Math.max(lastAt, entry.lastAt);
  }
  if (!samples) return null;
  return {
    samples,
    ttftMs: ttftSamples ? Math.round(ttftWeighted / ttftSamples) : null,
    errorRate: Math.round((errorWeighted / samples) * 1000) / 1000,
    openModels,
    lastAt,
  };
}

/**
 * Accounts ordered best first for a model: untried accounts first (so each gets
 * measured), then by breaker, error rate and time to first token. Ties keep the
 * input order (the configured priority). With probability `explore`, the first
 * healthy account swaps with a random other healthy one so a slow account that
 * recovered can be noticed; `random` is injectable for tests.
 */
export function rankByHealth(connections, model = null, { now = Date.now(), explore = 0, random = Math.random } = {}) {
  const scored = connections.map((conn, index) => {
    const entry = state.entries.get(keyOf(conn.id, model));
    return {
      conn,
      index,
      untried: !entry || entry.samples === 0,
      breaker: BREAKER_RANK[breakerState(entry, now)],
      errorBucket: entry ? Math.round(entry.errorRate / ERROR_RATE_STEP) : 0,
      ttft: entry?.ttftMs ?? entry?.latencyMs ?? null,
    };
  });
  const measured = scored.map((s) => s.ttft).filter((t) => t !== null);
  const fastest = measured.length ? Math.min(...measured) : null;
  const ttftBucket = (t) => (t === null || !fastest ? 0 : Math.floor(Math.log(Math.max(t, 1) / Math.max(fastest, 1)) / Math.log(TTFT_TOLERANCE)));
  scored.sort((a, b) =>
    (b.untried - a.untried)
    || (a.breaker - b.breaker)
    || (a.errorBucket - b.errorBucket)
    || (ttftBucket(a.ttft) - ttftBucket(b.ttft))
    || (a.index - b.index));
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
export function resetProviderHealth() {
  state.entries.clear();
}
