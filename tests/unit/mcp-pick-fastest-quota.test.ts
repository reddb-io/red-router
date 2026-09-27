import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSpeedCandidates,
  providerQuotaStanding,
} from "../../open-sse/mcp-server/tools/pickFastestModel.ts";
import { normalizeQuotaResponse } from "../../src/shared/contracts/quota.ts";

test("fastest-model quota excludes a provider only when every account is known empty", () => {
  const providers = normalizeQuotaResponse([
    { provider: "openai", connectionId: "a", quotaUsed: 100, quotaTotal: 100 },
    { provider: "openai", connectionId: "b", quotaUsed: 50, quotaTotal: 100 },
    { provider: "anthropic", connectionId: "c", quotaUsed: 20, quotaTotal: 20 },
  ]).providers;

  assert.deepEqual(providerQuotaStanding(providers, "openai"), {
    remaining: 50,
    total: 100,
    exhausted: false,
  });
  assert.deepEqual(providerQuotaStanding(providers, "anthropic"), {
    remaining: 0,
    total: 20,
    exhausted: true,
  });
});

test("fastest-model quota keeps missing and unmeasured accounts eligible", () => {
  const providers = normalizeQuotaResponse([
    { provider: "openai", connectionId: "a", quotaUsed: 100, quotaTotal: 100 },
    { provider: "openai", connectionId: "b", quotaUsed: 0, quotaTotal: null },
  ]).providers;

  assert.deepEqual(providerQuotaStanding(providers, "openai"), {
    remaining: 100,
    total: 100,
    exhausted: false,
  });
  assert.deepEqual(providerQuotaStanding(providers, "missing"), {
    remaining: 100,
    total: 100,
    exhausted: false,
  });
});

test("fastest-model candidates skip only providers with all accounts exhausted", () => {
  const providers = normalizeQuotaResponse([
    { provider: "openai", connectionId: "a", quotaUsed: 100, quotaTotal: 100 },
    { provider: "anthropic", connectionId: "b", quotaUsed: 20, quotaTotal: 100 },
  ]).providers;
  const candidates = buildSpeedCandidates(
    [
      {
        models: [
          { provider: "openai", model: "gpt-4.1" },
          { provider: "anthropic", model: "claude-sonnet-4-5" },
        ],
      },
    ],
    {
      combos: [],
      breakers: [],
      providers,
      analyticsByProvider: {},
      analyticsTop: {},
    }
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.provider),
    ["anthropic"]
  );
  assert.equal(candidates[0]?.quotaRemaining, 80);
});
