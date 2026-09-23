// Per-key limits: requests per minute (in memory), tokens per local day and
// spend per local month (from the usage rollups). Over a limit → 429 with a
// Retry-After pointing at when the window frees up.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

let limits;
let repo;
let getDb;
let errors;

beforeAll(async () => {
  repo = await import("@/lib/db/repos/apiKeysRepo.js");
  ({ getDb } = await import("@/lib/db/kysely.js"));
  limits = await import("@/lib/apiKeyLimits.js");
  errors = await import("../../open-sse/utils/error.js");
});

beforeEach(() => limits.resetApiKeyLimits());

async function keyWith(keyLimits) {
  const key = await repo.createApiKey("limited", "m1");
  await repo.updateApiKey(key.id, { limits: keyLimits });
  return key.key;
}

const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function seedDay(date, byApiKey) {
  const db = await getDb();
  await db.insertInto("usageDaily").values({ dateKey: dateKey(date), data: JSON.stringify({ requests: 1, byApiKey }) })
    .onConflict((oc) => oc.column("dateKey").doUpdateSet({ data: JSON.stringify({ requests: 1, byApiKey }) })).execute();
}

describe("rpm", () => {
  it("allows rpm requests per rolling minute, then answers 429 until the oldest ages out", async () => {
    const apiKey = await keyWith({ rpm: 2 });
    const t0 = Date.now();
    expect(await limits.checkApiKeyLimits(apiKey, { now: t0 })).toBeNull();
    expect(await limits.checkApiKeyLimits(apiKey, { now: t0 + 1000 })).toBeNull();
    const over = await limits.checkApiKeyLimits(apiKey, { now: t0 + 2000 });
    expect(over).toMatchObject({ reason: "api_key_limit", status: 429, retryAtMs: t0 + 60_000 });
    // A refused request does not take a slot.
    expect(await limits.checkApiKeyLimits(apiKey, { now: t0 + 60_000 })).toBeNull();
    expect(await limits.checkApiKeyLimits(apiKey, { now: t0 + 60_500 })).not.toBeNull();
  });

  it("is tracked per key", async () => {
    const a = await keyWith({ rpm: 1 });
    const b = await keyWith({ rpm: 1 });
    const now = Date.now();
    expect(await limits.checkApiKeyLimits(a, { now })).toBeNull();
    expect(await limits.checkApiKeyLimits(b, { now })).toBeNull();
    expect(await limits.checkApiKeyLimits(a, { now })).not.toBeNull();
  });
});

describe("tokens per day and spend per month", () => {
  it("counts today's tokens for this key only and retries after local midnight", async () => {
    const apiKey = await keyWith({ tokensPerDay: 1000 });
    const now = new Date(2026, 5, 15, 12);
    await seedDay(now, {
      [`${apiKey}|gpt-5|openai`]: { promptTokens: 600, completionTokens: 400, cost: 0 },
      [`sk-other|gpt-5|openai`]: { promptTokens: 99999, completionTokens: 0, cost: 0 },
    });
    const over = await limits.checkApiKeyLimits(apiKey, { now: now.getTime() });
    expect(over).toMatchObject({ reason: "api_key_limit", status: 429 });
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    expect(over.retryAtMs).toBe(midnight);
  });

  it("sums cost over the month and retries on the 1st", async () => {
    const apiKey = await keyWith({ usdPerMonth: 1 });
    // A fixed mid-month instant: the month's first day already has usage.
    const now = new Date(2026, 6, 20, 9);
    await seedDay(now, { [`${apiKey}|m|p`]: { promptTokens: 1, completionTokens: 1, cost: 0.6 } });
    // Last month does not count.
    await seedDay(new Date(2026, 5, 30), { [`${apiKey}|m|p`]: { promptTokens: 1, completionTokens: 1, cost: 50 } });
    expect(await limits.checkApiKeyLimits(apiKey, { now: now.getTime() })).toBeNull();

    // Cached for 10 s: new usage shows up once the cache expires.
    await seedDay(new Date(2026, 6, 1), { [`${apiKey}|m|p`]: { promptTokens: 1, completionTokens: 1, cost: 0.5 } });
    expect(await limits.checkApiKeyLimits(apiKey, { now: now.getTime() + 1000 })).toBeNull();
    const over = await limits.checkApiKeyLimits(apiKey, { now: now.getTime() + 11_000 });
    expect(over).toMatchObject({ reason: "api_key_limit" });
    expect(over.retryAtMs).toBe(new Date(2026, 7, 1).getTime());
  });

  it("keys without limits, or without a key, are never limited", async () => {
    const key = await repo.createApiKey("free", "m1");
    expect(await limits.checkApiKeyLimits(key.key)).toBeNull();
    expect(await limits.checkApiKeyLimits(null)).toBeNull();
  });
});

describe("the 429 response", () => {
  it("carries Retry-After and the api_key_limit reason", async () => {
    const apiKey = await keyWith({ rpm: 1 });
    await limits.checkApiKeyLimits(apiKey);
    const over = await limits.checkApiKeyLimits(apiKey);
    const response = errors.responseFromRoutingCandidate(over, { errorFormat: "openai" });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(response.headers.get("X-9Router-Reason")).toBe("api_key_limit");
    expect((await response.json()).error.code).toBe("rate_limit_exceeded");
  });
});

describe("normalizeKeyLimits", () => {
  it("drops blanks, zeros and garbage", async () => {
    const { normalizeKeyLimits } = await import("@/lib/apiKeyPolicy.js");
    expect(normalizeKeyLimits({ rpm: 0, tokensPerDay: "", usdPerMonth: "abc" })).toBeNull();
    expect(normalizeKeyLimits({ rpm: "10.7", tokensPerDay: 5000, usdPerMonth: 0.004 })).toEqual({ rpm: 10, tokensPerDay: 5000, usdPerMonth: 0.01 });
  });
});
