import assert from "node:assert/strict";
import { test } from "node:test";
import { SemanticCacheManager } from "../../../open-sse/services/cache/semanticCacheManager.ts";
import { MemoryVectorStore } from "../../../open-sse/services/cache/memoryVectorStore.ts";
import {
  buildVerificationProof,
  prepareSemanticVerification,
  readReuseProbability,
} from "../../../open-sse/services/cache/semanticVerification.ts";
import { getCacheVerificationStats } from "../../../open-sse/services/cache/verificationStats.ts";

const original = {
  temperature: 0,
  max_tokens: 400,
  messages: [
    { role: "system", content: "Answer in Portuguese." },
    { role: "user", content: "Como cancelar minha assinatura?" },
  ],
};
const similar = {
  ...original,
  messages: [
    original.messages[0],
    { role: "user", content: "Como cancelar minha assinatura e pedir estorno?" },
  ],
};
const response = {
  choices: [
    {
      finish_reason: "stop",
      message: { role: "assistant", content: "Abra Settings e selecione Cancel subscription." },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 30 },
};
const scope = { model: "s2", provider: "openrouter", apiKeyId: "tenant-a-key" };
async function setup(verificationEnabled = true) {
  const store = new MemoryVectorStore();
  const manager = new SemanticCacheManager(
    { enabled: true, verificationEnabled, verificationTimeoutMs: 100, cacheByProvider: true },
    store,
    async () => ({ embedding: [1, 0], inputTokens: 5 })
  );
  await manager.store({ ...scope, body: original, response });
  return { manager, store };
}

test("exact hits and legacy similarity never invoke a verifier; disabled cache makes no calls", async () => {
  for (const enabled of [true, false]) {
    const { manager } = await setup(enabled);
    const result = await manager.lookup({
      ...scope,
      body: original,
      verifySemantic: async () => {
        throw new Error("unexpected decision");
      },
    });
    assert.equal(result.type, "exact");
    assert.equal(result.hit, true);
  }
  const { manager } = await setup(false);
  assert.equal((await manager.lookup({ ...scope, body: similar })).type, "semantic");
  manager.updateConfig({ enabled: false });
  manager.setEmbeddingGenerator(async () => {
    throw new Error("unexpected embedding");
  });
  assert.equal((await manager.lookup({ ...scope, body: original })).hit, false);
});

test("semantic candidates require an explicit acceptance and preserve the full questions", async () => {
  const { manager } = await setup();
  assert.equal((await manager.lookup({ ...scope, body: similar })).hit, false);
  for (const outcome of ["rejected", "unavailable", "accepted"] as const) {
    const result = await manager.lookup({
      ...scope,
      body: similar,
      verifySemantic: async ({ state }) => {
        assert.equal(state.currentQuestion, similar.messages[1].content);
        assert.equal(state.cachedQuestion, original.messages[1].content);
        assert.ok(state.context.includes("Answer in Portuguese."));
        return { outcome, evaluationCostUsd: 0.001, avoidedCostEstimateUsd: 0.01 };
      },
    });
    assert.equal(result.hit, outcome === "accepted");
  }
  assert.equal(
    (
      await manager.lookup({
        ...scope,
        body: similar,
        verifySemantic: async () => {
          throw new Error("transport failed");
        },
      })
    ).hit,
    false
  );
  const stats = getCacheVerificationStats();
  assert.ok(stats.accepted >= 1 && stats.rejected >= 1 && stats.unavailable >= 2);
  assert.ok(stats.knownEvaluationCostUsd >= 0.003);
});

test("contract, instructions, history, namespace, tools and model changes cannot be approved", async () => {
  const { manager, store } = await setup();
  const hit = await manager.lookup({ ...scope, body: original });
  const entry = hit.entry!;
  let calls = 0;
  const approve = async () => {
    calls++;
    return { outcome: "accepted" as const };
  };
  for (const body of [
    { ...similar, max_tokens: 800 },
    { ...similar, response_format: { type: "json_object" } },
    {
      ...similar,
      messages: [{ role: "system", content: "Answer in English." }, similar.messages[1]],
    },
    {
      ...similar,
      messages: [
        original.messages[0],
        { role: "assistant", content: "Different history" },
        similar.messages[1],
      ],
    },
    { ...similar, tools: [] },
    {
      ...similar,
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://image.test" } }],
        },
      ],
    },
  ]) {
    assert.equal((await manager.lookup({ ...scope, body, verifySemantic: approve })).hit, false);
  }
  for (const changed of [{ apiKeyId: "tenant-b-key" }, { provider: "other" }, { model: "other" }]) {
    assert.equal(prepareSemanticVerification(similar, entry, { ...scope, ...changed }), null);
  }
  assert.equal(
    prepareSemanticVerification(similar, { ...entry, cacheKey: "private" }, scope),
    null
  );
  assert.equal(
    prepareSemanticVerification(similar, { ...entry, expiresAt: Date.now() - 1 }, scope),
    null
  );
  assert.equal(
    prepareSemanticVerification(
      similar,
      {
        ...entry,
        response: { choices: [{ finish_reason: "length", message: { content: "cut off" } }] },
      },
      scope
    ),
    null
  );
  await store.set({ ...entry, verificationProof: undefined }, 60000);
  assert.equal(
    (await manager.lookup({ ...scope, body: similar, verifySemantic: approve })).hit,
    false
  );
  assert.equal(
    (await manager.lookup({ ...scope, body: original, verifySemantic: approve })).hit,
    true
  );
  assert.equal(calls, 0);
});

test("bounded evidence and verdicts reject truncation, coercion and invalid scores", () => {
  assert.equal(buildVerificationProof({ ...similar, instructions: "x".repeat(24000) }), undefined);
  const proof = buildVerificationProof(original)!;
  assert.equal(
    proof.invariantHash,
    buildVerificationProof({ messages: original.messages, max_tokens: 400, temperature: 0 })!
      .invariantHash
  );
  for (const noul of ["0.99", null, true, 2, -1, NaN, Infinity]) {
    assert.equal(readReuseProbability({ answers: { reusable: { type: "noul", noul } } }), null);
  }
  assert.equal(
    readReuseProbability({ answers: { reusable: { type: "choice", noul: 0.99 } } }),
    null
  );
  assert.equal(readReuseProbability({ answers: { reusable: { type: "noul", noul: 0.99 } } }), 0.99);
});

test("router-injected context must match and the initial exact pass spends no embedding calls", async () => {
  let embeddingCalls = 0;
  const manager = new SemanticCacheManager(
    { enabled: true, verificationEnabled: true },
    new MemoryVectorStore(),
    async () => {
      embeddingCalls++;
      return { embedding: [1, 0], inputTokens: 5 };
    }
  );
  const withMemory = (body: typeof original, memory: string) => ({
    ...body,
    messages: [{ role: "system", content: memory }, ...body.messages],
  });
  await manager.store({
    ...scope,
    body: original,
    verificationBody: withMemory(original, "Account policy: no refunds."),
    response,
  });
  const before = embeddingCalls;
  assert.equal(
    (await manager.lookup({ ...scope, body: similar, allowSemantic: false })).hit,
    false
  );
  assert.equal(embeddingCalls, before);
  let decisions = 0;
  const approve = async () => {
    decisions++;
    return { outcome: "accepted" as const };
  };
  assert.equal(
    (
      await manager.lookup({
        ...scope,
        body: similar,
        verificationBody: withMemory(similar, "Account policy: refunds within 7 days."),
        verifySemantic: approve,
      })
    ).hit,
    false
  );
  assert.equal(decisions, 0);
  assert.equal(
    (
      await manager.lookup({
        ...scope,
        body: similar,
        verificationBody: withMemory(similar, "Account policy: no refunds."),
        verifySemantic: approve,
      })
    ).hit,
    true
  );
  assert.equal(decisions, 1);
  assert.equal(
    (
      await manager.lookup({
        ...scope,
        body: similar,
        verificationBody: {
          ...similar,
          tools: [{ type: "function", function: { name: "lookup_account" } }],
        },
        verifySemantic: approve,
      })
    ).hit,
    false
  );
  assert.equal(decisions, 1);
});

test("deadline, caller cancellation and expiry during evaluation all fall back to generation", async () => {
  const { manager } = await setup();
  // Keep the event loop alive because AbortSignal.timeout uses an unref'd timer.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const started = Date.now();
    assert.equal(
      (
        await manager.lookup({
          ...scope,
          body: similar,
          verifySemantic: () => new Promise(() => {}),
        })
      ).hit,
      false
    );
    assert.ok(Date.now() - started < 2000);
    const controller = new AbortController();
    const pending = manager.lookup({
      ...scope,
      body: similar,
      signal: controller.signal,
      verifySemantic: async (_input, signal) => {
        controller.abort();
        assert.equal(signal.aborted, true);
        return { outcome: "accepted" };
      },
    });
    assert.equal((await pending).hit, false);
    assert.equal(
      (
        await manager.lookup({
          ...scope,
          body: similar,
          verifySemantic: async ({ entry }) => {
            entry.expiresAt = Date.now() - 1;
            return { outcome: "accepted" };
          },
        })
      ).hit,
      false
    );
  } finally {
    clearInterval(keepAlive);
  }
});
