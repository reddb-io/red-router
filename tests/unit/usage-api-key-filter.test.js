import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "9r-usage-key-"));

let usageRepo;
const KEY_A = "sk-aaaaaaaaaaaa";
const KEY_B = "sk-bbbbbbbbbbbb";

const entry = (apiKey, model, prompt) => ({
  provider: "claude",
  model,
  apiKey,
  connectionId: "conn-1",
  endpoint: "/v1/messages",
  timestamp: new Date().toISOString(),
  tokens: { prompt_tokens: prompt, completion_tokens: 10 },
});

beforeAll(async () => {
  usageRepo = await import("@/lib/db/repos/usageRepo.js");
  await usageRepo.saveRequestUsage(entry(KEY_A, "claude-opus-5", 100));
  await usageRepo.saveRequestUsage(entry(KEY_A, "claude-sonnet-5", 200));
  await usageRepo.saveRequestUsage(entry(KEY_B, "claude-haiku-4-5", 400));
});

const keyNames = (stats) => [...new Set(Object.values(stats.byApiKey).map((e) => e.apiKeyMasked))].sort();

describe("usage stats — API key filter", () => {
  it("counts every key when unfiltered", async () => {
    const stats = await usageRepo.getUsageStats("today");
    expect(stats.totalPromptTokens).toBe(700);
    expect(keyNames(stats)).toHaveLength(2);
  });

  it("narrows totals and rows to one key", async () => {
    const stats = await usageRepo.getUsageStats("today", { apiKey: KEY_A });
    expect(stats.totalPromptTokens).toBe(300);
    expect(keyNames(stats)).toEqual(["sk-aaaaa***aaaa"]);
    expect(stats.recentRequests.every((r) => r.apiKeyMasked === "sk-aaaaa***aaaa")).toBe(true);
  });

  // A longer period would normally read the key-less daily rollups; with a key
  // filter it must fall back to per-request history or the filter is ignored.
  it("still filters on a period that would use daily rollups", async () => {
    const stats = await usageRepo.getUsageStats("7d", { apiKey: KEY_B });
    expect(stats.totalPromptTokens).toBe(400);
    expect(keyNames(stats)).toEqual(["sk-bbbbb***bbbb"]);
  });

  // The rollup periods keyed byApiKey rows by the raw key, so the full key went
  // out in the stats JSON as an object key. Every period, filtered or not.
  it.each(["today", "24h", "7d", "30d", "60d", "all"])("never returns a raw key (%s)", async (period) => {
    for (const options of [{}, { apiKey: KEY_A }]) {
      const json = JSON.stringify(await usageRepo.getUsageStats(period, options));
      expect(json).not.toContain(KEY_A);
      expect(json).not.toContain(KEY_B);
    }
  });

  it("keys rows by an opaque reference that keeps two keys apart", async () => {
    const stats = await usageRepo.getUsageStats("7d");
    const keys = Object.keys(stats.byApiKey);
    expect(keys.every((k) => k.startsWith("key_") || k.startsWith("local-no-key"))).toBe(true);
    expect(new Set(keys.map((k) => k.split("|")[0])).size).toBe(2);
  });
});
