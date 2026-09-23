import { getApiKeyPolicy, getApiKeyUsageTotals } from "@/lib/db/index.js";

// Per-key usage limits, checked once per request after the key is known:
//   rpm           requests in any rolling 60 s (in memory, per process);
//   tokensPerDay  prompt + completion tokens on the local calendar day;
//   usdPerMonth   recorded cost over the local calendar month.
// Token and cost totals come from the usage rollups, which land after a request
// finishes, so a burst can overshoot by the requests already in flight.

const RPM_WINDOW_MS = 60_000;
const USAGE_CACHE_MS = 10_000;

const recentByKey = new Map(); // apiKey -> ascending request timestamps (ms)
const usageCache = new Map(); // apiKey -> { at, totals }

function limitCandidate(message, retryAtMs) {
  return { reason: "api_key_limit", status: 429, errorType: "rate_limit_error", message, retryable: true, retryAtMs };
}

function nextLocalMidnight(nowMs) {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

function nextLocalMonth(nowMs) {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

async function usageTotals(apiKey, nowMs) {
  const cached = usageCache.get(apiKey);
  if (cached && nowMs - cached.at < USAGE_CACHE_MS) return cached.totals;
  const totals = await getApiKeyUsageTotals(apiKey, new Date(nowMs));
  usageCache.set(apiKey, { at: nowMs, totals });
  return totals;
}

/**
 * Null when the key may send this request (and the request is counted toward
 * its rpm), else a routing candidate answered as 429 with Retry-After.
 */
export async function checkApiKeyLimits(apiKey, { now = Date.now() } = {}) {
  if (!apiKey) return null;
  const { limits } = await getApiKeyPolicy(apiKey);
  if (!limits) return null;

  if (limits.tokensPerDay || limits.usdPerMonth) {
    const totals = await usageTotals(apiKey, now);
    if (limits.tokensPerDay && totals.tokensToday >= limits.tokensPerDay) {
      return limitCandidate(`API key daily token limit reached (${limits.tokensPerDay})`, nextLocalMidnight(now));
    }
    if (limits.usdPerMonth && totals.costThisMonth >= limits.usdPerMonth) {
      return limitCandidate(`API key monthly spend limit reached ($${limits.usdPerMonth})`, nextLocalMonth(now));
    }
  }

  if (limits.rpm) {
    const recent = (recentByKey.get(apiKey) || []).filter((t) => now - t < RPM_WINDOW_MS);
    if (recent.length >= limits.rpm) {
      recentByKey.set(apiKey, recent);
      return limitCandidate(`API key rate limit reached (${limits.rpm} requests/min)`, recent[0] + RPM_WINDOW_MS);
    }
    recent.push(now);
    recentByKey.set(apiKey, recent);
  }
  return null;
}

/** Test hook: forget request windows and cached usage. */
export function resetApiKeyLimits() {
  recentByKey.clear();
  usageCache.clear();
}
