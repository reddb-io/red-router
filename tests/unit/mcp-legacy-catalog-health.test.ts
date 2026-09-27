import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLegacyCatalogHealth,
  type LegacyHealthConnection,
  type LegacyHealthSignals,
} from "../../src/lib/mcp/legacyCatalogHealth.ts";

const models = [
  { id: "claude/opus", owned_by: "claude" },
  { id: "claude/sonnet", owned_by: "claude" },
  { id: "combo/fallback", owned_by: "combo", members: ["claude/opus", "claude/sonnet"] },
];

const noBlocks: LegacyHealthSignals = {
  modelLock: () => null,
  quotaExhausted: () => false,
};

function connection(
  id: string,
  overrides: Partial<LegacyHealthConnection> = {}
): LegacyHealthConnection {
  return {
    id,
    provider: "claude",
    isActive: true,
    rateLimitedUntil: null,
    testStatus: "success",
    ...overrides,
  };
}

test("legacy model health respects the calling key's allowed connection IDs", () => {
  const health = buildLegacyCatalogHealth(
    models,
    [connection("private"), connection("allowed", { isActive: false })],
    new Set(["allowed"]),
    noBlocks,
    1_000
  );
  assert.deepEqual(health["claude/opus"], { status: { state: "disabled" }, usable: false });
  assert.deepEqual(health["combo/fallback"], { status: { state: "disabled" }, usable: false });
  assert.equal(JSON.stringify(health).includes("private"), false);
});

test("legacy model health accounts for model locks, quota and connection cooldown", () => {
  const health = buildLegacyCatalogHealth(
    models,
    [connection("allowed")],
    null,
    {
      modelLock: (_provider, _connection, model) =>
        model === "opus" ? { reason: "quota_exhausted", remainingMs: 5_000 } : null,
      quotaExhausted: (_connection, _provider, model) => model === "sonnet",
    },
    1_000
  );
  assert.deepEqual(health["claude/opus"], {
    status: { state: "quota_exhausted", until: new Date(6_000).toISOString() },
    usable: false,
  });
  assert.equal(health["claude/sonnet"].status.state, "quota_exhausted");
  assert.equal(health["combo/fallback"].usable, false);

  const cooling = buildLegacyCatalogHealth(
    models,
    [connection("allowed", { rateLimitedUntil: new Date(10_000).toISOString() })],
    null,
    noBlocks,
    1_000
  );
  assert.equal(cooling["claude/opus"].status.state, "rate_limited");
});

test("unknown health never becomes a usable recommendation, but one healthy combo member does", () => {
  const unknown = buildLegacyCatalogHealth(
    models,
    [connection("uncertain", { testStatus: "unknown" })],
    null,
    noBlocks
  );
  assert.equal(unknown["claude/opus"].usable, null);
  assert.equal(unknown["combo/fallback"].usable, null);

  const mixed = buildLegacyCatalogHealth(
    models,
    [
      connection("healthy"),
      connection("cooling", { rateLimitedUntil: new Date(Date.now() + 60_000).toISOString() }),
    ],
    null,
    noBlocks
  );
  assert.equal(mixed["combo/fallback"].usable, true);
});

test("OpenRouter free models are not blocked by exhausted paid credits", () => {
  const health = buildLegacyCatalogHealth(
    [
      { id: "openrouter/openai/gpt-oss-20b:free", owned_by: "openrouter" },
      { id: "openrouter/openai/gpt-4o", owned_by: "openrouter" },
    ],
    [connection("openrouter-key", { provider: "openrouter", testStatus: "credits_exhausted" })],
    null,
    noBlocks
  );
  assert.equal(health["openrouter/openai/gpt-oss-20b:free"].status.state, "unknown");
  assert.equal(health["openrouter/openai/gpt-oss-20b:free"].usable, null);
  assert.equal(health["openrouter/openai/gpt-4o"].status.state, "quota_exhausted");
  assert.equal(health["openrouter/openai/gpt-4o"].usable, false);
});
