import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "redrouter-shared-rpm-"));
process.env.DATA_DIR = directory;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "shared-rpm-ci-only-secret";
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { upsertKeyQuotaLimits, reserveSharedKeyRpm, getQuotaWindowCount } =
  await import("../../../src/lib/db/keyQuota.ts");
const { recordKeyQuotaUsage } = await import("../../../src/domain/keyQuota.ts");
const { createApiKey, getApiKeyMetadata } = await import("../../../src/lib/db/apiKeys.ts");
const { enforceApiKeyPolicy } = await import("../../../src/shared/utils/apiKeyPolicy.ts");
const {
  ChatSharedUsageAdmissionError,
  executeWithChatSharedUsageAdmission,
  trySettleChatSharedUsageAttempt,
} = await import("../../../open-sse/handlers/chatCore/sharedUsageAdmission.ts");

after(() => {
  resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});

test("request policy reserves once without mutating cached client metadata", async () => {
  const previous = process.env.RED_ROUTER_PRODUCT_SHARED_RPM;
  process.env.RED_ROUTER_PRODUCT_SHARED_RPM = "1";
  try {
    const key = await createApiKey("mixed-rpm", "ci-machine");
    upsertKeyQuotaLimits(key.id, { rpmLimit: 1 });
    const request = () =>
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key.key}` },
      });
    const accepted = await enforceApiKeyPolicy(request(), "openrouter/openai/gpt");
    assert.equal(accepted.rejection, null);
    assert.equal(accepted.apiKeyInfo?.sharedRpmReserved, true);
    assert.equal(
      ((await getApiKeyMetadata(key.key)) as { sharedRpmReserved?: boolean }).sharedRpmReserved,
      undefined
    );
    recordKeyQuotaUsage(key.id, 12, { skipRpm: accepted.apiKeyInfo?.sharedRpmReserved === true });
    const rejected = await enforceApiKeyPolicy(request(), "openrouter/openai/gpt");
    assert.equal(rejected.rejection?.status, 429);
  } finally {
    if (previous === undefined) delete process.env.RED_ROUTER_PRODUCT_SHARED_RPM;
    else process.env.RED_ROUTER_PRODUCT_SHARED_RPM = previous;
  }
});

test("shared RPM admission is durable and completion only adds tokens", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  upsertKeyQuotaLimits("shared-client", { rpmLimit: 2 });
  assert.equal(reserveSharedKeyRpm("shared-client", now), true);
  assert.equal(reserveSharedKeyRpm("shared-client", now + 1), true);
  assert.equal(reserveSharedKeyRpm("shared-client", now + 2), false);
  recordKeyQuotaUsage("shared-client", 15, { now: () => now + 3, skipRpm: true });
  assert.equal(getQuotaWindowCount("shared-client", "key-quota:rpm", now + 3), 2);
  assert.equal(getQuotaWindowCount("shared-client", "key-quota:tpm", now + 3), 15);
  assert.equal(reserveSharedKeyRpm("shared-client", now + 60_000), false);
  assert.equal(reserveSharedKeyRpm("shared-client", now + 90_000), true);
  const row = getDbInstance()
    .prepare(
      "SELECT SUM(consumed) AS n FROM api_key_quota_counters WHERE api_key_id = ? AND dimension_key = ?"
    )
    .get("shared-client", "key-quota:rpm") as { n: number };
  assert.equal(row.n, 3);
});

test("strict mode blocks unreserved TypeScript but admits wired chat and System One paths", async () => {
  const oldRpm = process.env.RED_ROUTER_PRODUCT_SHARED_RPM;
  const oldStrict = process.env.RED_ROUTER_PRODUCT_STRICT_QUOTAS;
  const oldConcurrent = process.env.RED_ROUTER_PRODUCT_CONCURRENT_QUOTAS;
  process.env.RED_ROUTER_PRODUCT_SHARED_RPM = "1";
  process.env.RED_ROUTER_PRODUCT_STRICT_QUOTAS = "1";
  try {
    for (const limits of [{ tpmLimit: 100 }, { dailyTokensLimit: 100 }, { monthlyAmountUsd: 1 }]) {
      const key = await createApiKey("strict-guard", "ci-machine");
      upsertKeyQuotaLimits(key.id, limits);
      const request = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key.key}` },
      });
      const verdict = await enforceApiKeyPolicy(request, "openrouter/openai/gpt");
      assert.equal(verdict.rejection?.status, 503);
    }
    const unrestricted = await createApiKey("strict-unrestricted", "ci-machine");
    const request = () =>
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${unrestricted.key}` },
      });
    assert.equal((await enforceApiKeyPolicy(request(), "openrouter/openai/gpt")).rejection, null);
    delete process.env.RED_ROUTER_PRODUCT_SHARED_RPM;
    assert.equal(
      (await enforceApiKeyPolicy(request(), "openrouter/openai/gpt")).rejection?.status,
      503
    );
    process.env.RED_ROUTER_PRODUCT_SHARED_RPM = "1";
    process.env.RED_ROUTER_PRODUCT_CONCURRENT_QUOTAS = "1";
    const systemOne = await createApiKey("strict-system-one", "ci-machine");
    upsertKeyQuotaLimits(systemOne.id, { tpmLimit: 100 });
    const systemOneRequest = new Request("http://localhost/v1/systemone", {
      method: "POST",
      headers: { authorization: `Bearer ${systemOne.key}` },
    });
    const systemOnePolicy = await enforceApiKeyPolicy(systemOneRequest, "typesafe-ai/jev-latest", {
      concurrentUsageReservation: true,
    });
    assert.equal(systemOnePolicy.rejection, null);
    assert.equal(systemOnePolicy.apiKeyInfo?.sharedRpmReserved, true);

    const chat = await createApiKey("strict-chat", "ci-machine");
    upsertKeyQuotaLimits(chat.id, { tpmLimit: 100 });
    const chatPolicy = await enforceApiKeyPolicy(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${chat.key}` },
      }),
      "openrouter/openai/gpt",
      { meteredBudget: "defer-to-candidate", concurrentUsageReservation: true }
    );
    assert.equal(chatPolicy.rejection, null);
    assert.equal(chatPolicy.apiKeyInfo?.sharedRpmReserved, true);
  } finally {
    if (oldRpm === undefined) delete process.env.RED_ROUTER_PRODUCT_SHARED_RPM;
    else process.env.RED_ROUTER_PRODUCT_SHARED_RPM = oldRpm;
    if (oldStrict === undefined) delete process.env.RED_ROUTER_PRODUCT_STRICT_QUOTAS;
    else process.env.RED_ROUTER_PRODUCT_STRICT_QUOTAS = oldStrict;
    if (oldConcurrent === undefined) delete process.env.RED_ROUTER_PRODUCT_CONCURRENT_QUOTAS;
    else process.env.RED_ROUTER_PRODUCT_CONCURRENT_QUOTAS = oldConcurrent;
  }
});

test("chat dispatch reserves before execute and fails closed without calling a provider", async () => {
  const previousStrict = process.env.RED_ROUTER_PRODUCT_STRICT_QUOTAS;
  const previousConcurrent = process.env.RED_ROUTER_PRODUCT_CONCURRENT_QUOTAS;
  process.env.RED_ROUTER_PRODUCT_STRICT_QUOTAS = "1";
  process.env.RED_ROUTER_PRODUCT_CONCURRENT_QUOTAS = "1";
  const attempt = {
    id: "chat-attempt",
    keyId: "chat-key",
    provider: "openrouter" as const,
    model: "openai/gpt",
    prices: { input: 1, output: 2, cached: 1, cacheCreation: 1, reasoning: 2 },
  };
  try {
    let executed = false;
    await assert.rejects(
      executeWithChatSharedUsageAdmission(
        {
          apiKeyId: "chat-key",
          provider: "openrouter",
          model: "openai/gpt",
          onReserved: () => assert.fail("denied admission cannot reserve"),
          execute: async () => {
            executed = true;
            return "unexpected";
          },
        },
        { begin: async () => ({ state: "denied" }) }
      ),
      (error: unknown) =>
        error instanceof ChatSharedUsageAdmissionError &&
        error.status === 429 &&
        error.code === "budget_exceeded"
    );
    assert.equal(executed, false);

    const order: string[] = [];
    const result = await executeWithChatSharedUsageAdmission(
      {
        apiKeyId: "chat-key",
        provider: "openrouter",
        model: "openai/gpt",
        onReserved: (reserved) => {
          assert.equal(reserved, attempt);
          order.push("reserved");
        },
        execute: async () => {
          order.push("execute");
          return "ok";
        },
      },
      { begin: async () => ({ state: "reserved", attempt }) }
    );
    assert.equal(result, "ok");
    assert.deepEqual(order, ["reserved", "execute"]);

    let settledUsage: Record<string, number> | null = null;
    assert.equal(
      trySettleChatSharedUsageAttempt(attempt, { prompt_tokens: 3, completion_tokens: 4 }, null, {
        settle: (_attempt, usage) => {
          settledUsage = usage;
        },
      }),
      true
    );
    assert.deepEqual(settledUsage, { prompt_tokens: 3, completion_tokens: 4 });
    assert.equal(
      trySettleChatSharedUsageAttempt(attempt, { prompt_tokens: 3 }, null, {
        settle: () => {
          throw new Error("sqlite busy");
        },
      }),
      false
    );
  } finally {
    if (previousStrict === undefined) delete process.env.RED_ROUTER_PRODUCT_STRICT_QUOTAS;
    else process.env.RED_ROUTER_PRODUCT_STRICT_QUOTAS = previousStrict;
    if (previousConcurrent === undefined) delete process.env.RED_ROUTER_PRODUCT_CONCURRENT_QUOTAS;
    else process.env.RED_ROUTER_PRODUCT_CONCURRENT_QUOTAS = previousConcurrent;
  }
});
