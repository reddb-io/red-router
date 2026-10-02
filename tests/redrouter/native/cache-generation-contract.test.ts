import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  generateSignature,
  outputContractOf,
  isCacheableForRead,
  isCacheableForWrite,
} from "../../../src/lib/semanticCache.ts";
import { canUseLegacyResponseCache } from "../../../open-sse/services/cache/requestPolicy.ts";
import { SemanticCacheManager } from "../../../open-sse/services/cache/semanticCacheManager.ts";
import { MemoryVectorStore } from "../../../open-sse/services/cache/memoryVectorStore.ts";
import { RedisVectorStore } from "../../../open-sse/services/cache/redisVectorStore.ts";
import { isSemanticCacheEnabled } from "../../../open-sse/handlers/chatCore/semanticCache.ts";
import { storeSemanticCacheResponse } from "../../../open-sse/handlers/chatCore/semanticCacheStore.ts";
import { storeStreamingSemanticCacheResponse } from "../../../open-sse/handlers/chatCore/streamingSemanticCacheStore.ts";

const scope = { model: "reasoner", provider: "openrouter", apiKeyId: "tenant-a-key" };
const original = {
  temperature: 0,
  max_tokens: 400,
  reasoning: { effort: "low" },
  messages: [{ role: "user", content: "Explain this algorithm." }],
};
const similar = {
  ...original,
  messages: [{ role: "user", content: "Explain this algorithm please." }],
};
const response = {
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Cached answer" } }],
};

function signature(
  body: Record<string, unknown> & { temperature?: number; top_p?: number },
  key = scope.apiKeyId
): string {
  return generateSignature(
    scope.model,
    body.messages,
    body.temperature,
    body.top_p,
    key,
    outputContractOf(body)
  );
}

async function setup(verificationEnabled = false) {
  const store = new MemoryVectorStore();
  const manager = new SemanticCacheManager(
    { enabled: true, verificationEnabled, cacheByProvider: true },
    store,
    async () => ({ embedding: [1, 0], inputTokens: 1 })
  );
  await manager.store({ ...scope, body: original, response });
  return { manager, store };
}

test("effort, output limits and generation policy cannot reuse exact or fuzzy answers", async () => {
  for (const verificationEnabled of [false, true]) {
    const { manager } = await setup(verificationEnabled);
    for (const changed of [
      { reasoning: { effort: "high" } },
      { reasoning_effort: "high" },
      { thinking: { type: "enabled", budget_tokens: 8000 } },
      { output_config: { effort: "high" } },
      { max_tokens: 800 },
      { max_completion_tokens: 800 },
      { max_output_tokens: 800 },
      { seed: 42 },
      { stop: ["END"] },
      { top_k: 10 },
      { frequency_penalty: 1 },
      { parallel_tool_calls: false },
      { response_format: { type: "json_object" } },
      { text: { verbosity: "low" } },
      { options: { num_predict: 800 } },
      { generationConfig: { thinkingConfig: { thinkingBudget: 8000 } } },
      { extra_body: { chat_template_kwargs: { enable_thinking: false } } },
    ]) {
      const body = { ...original, ...changed };
      assert.notEqual(signature(body), signature(original));
      for (const messages of [original.messages, similar.messages]) {
        const result = await manager.lookup({
          ...scope,
          body: { ...body, messages },
          verifySemantic: async () => {
            throw new Error("An incompatible contract must not reach the verifier");
          },
        });
        assert.equal(result.hit, false, JSON.stringify(changed));
      }
    }
    assert.equal((await manager.lookup({ ...scope, body: original })).type, "exact");
  }
  const { manager } = await setup();
  assert.equal((await manager.lookup({ ...scope, body: similar })).type, "semantic");
  assert.equal(
    (await manager.lookup({ ...scope, apiKeyId: "tenant-b-key", body: similar })).hit,
    false
  );
});

test("JSON object ordering is stable while strict tool policy remains significant", () => {
  const a = { ...original, reasoning: { effort: "low", summary: "auto" } };
  const b = { ...original, reasoning: { summary: "auto", effort: "low" } };
  assert.equal(signature(a), signature(b));
  const tool = {
    type: "function",
    function: { name: "lookup", parameters: { type: "object" }, strict: true },
  };
  assert.notEqual(
    signature({ ...original, tools: [tool] }),
    signature({ ...original, tools: [{ ...tool, function: { ...tool.function, strict: false } }] })
  );
});

test("pre-contract cache entries are left intact but never replayed", async () => {
  const { manager, store } = await setup();
  const current = (await manager.lookup({ ...scope, body: original })).entry!;
  await store.clear();
  const oldHash = createHash("sha256")
    .update(
      JSON.stringify({
        model: scope.model,
        provider: scope.provider,
        messages: original.messages,
        temperature: 0,
        top_p: 1,
        outputContract: null,
      })
    )
    .digest("hex");
  const old = {
    ...current,
    hash: scope.apiKeyId + "." + oldHash,
    generationContractHash: undefined,
  };
  await store.set(old, 60000);
  assert.equal((await manager.lookup({ ...scope, body: original })).hit, false);
  assert.equal((await manager.lookup({ ...scope, body: similar })).hit, false);
  assert.ok(await store.get(old.id));
});

test("Redis filters contracts before selecting the nearest entry", async () => {
  const { manager } = await setup();
  const matching = (await manager.lookup({ ...scope, body: original })).entry!;
  const incompatible = { ...matching, id: "old", generationContractHash: undefined };
  const redis = new RedisVectorStore();
  Object.defineProperty(redis, "getClient", {
    value: async () => ({
      smembers: async () => [incompatible.id, matching.id],
      mget: async () => [JSON.stringify(incompatible), JSON.stringify(matching)],
    }),
  });
  const candidates = await redis.searchNearest(
    [1, 0],
    {
      apiKeyId: scope.apiKeyId,
      generationContractHash: matching.generationContractHash,
    },
    0.8,
    1
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].entry.id, matching.id);
});

test("key bypass cannot be overridden by cache headers and makes no embedding or store calls", async () => {
  const { manager, store } = await setup();
  const before = await store.getStats();
  manager.setEmbeddingGenerator(async () => {
    throw new Error("Unexpected paid embedding");
  });
  const bypass = {
    ...scope,
    body: original,
    cacheDefaultMode: "bypass" as const,
    headers: { "x-omniroute-cache-type": "both", "x-omniroute-cache-key": "force" },
  };
  assert.equal((await manager.lookup(bypass)).hit, false);
  await manager.store({ ...bypass, response });
  assert.deepEqual(await store.getStats(), before);
  assert.equal(isSemanticCacheEnabled({}, { cacheDefaultMode: "bypass" }), false);
  assert.equal(isSemanticCacheEnabled({ semanticCacheEnabled: false }), false);
  assert.equal(isSemanticCacheEnabled({}, { cacheDefaultMode: "legacy" }), true);

  const args = {
    ...bypass,
    enabled: true,
    translatedResponse: response,
    streamStatus: 200,
    streamResponseBody: response,
  };
  const forbidden = () => {
    throw new Error("Bypass must skip both legacy and vector writes");
  };
  const deps = {
    isCacheableForWrite: forbidden,
    isSmallEnoughForSemanticCache: forbidden,
    generateSignature: forbidden,
    setCachedResponse: forbidden,
  };
  storeSemanticCacheResponse(args, deps);
  storeStreamingSemanticCacheResponse(args, deps);
});

test("client bypass and no-store reach every cache layer for JSON and streaming", async () => {
  const { manager, store } = await setup();
  const before = await store.getStats();
  manager.setEmbeddingGenerator(async () => {
    throw new Error("Unexpected embedding");
  });
  for (const headers of [
    { Pragma: "no-cache" },
    { "Cache-Control": "private, no-store" },
    { "cache-control": "no-cache" },
    { "X-OmniRoute-No-Cache": "true" },
    { "x-omniroute-cache-no-store": "true" },
  ]) {
    const storeOnly = "x-omniroute-cache-no-store" in headers;
    assert.equal(isCacheableForRead(original, headers), storeOnly);
    assert.equal(isCacheableForWrite(original, headers), false);
    assert.equal((await manager.lookup({ ...scope, body: original, headers })).hit, storeOnly);
    await manager.store({ ...scope, body: original, headers, response });
    const forbidden = () => {
      throw new Error("Disabled writes reached storage");
    };
    const deps = {
      isCacheableForWrite,
      isSmallEnoughForSemanticCache: forbidden,
      generateSignature: forbidden,
      setCachedResponse: forbidden,
    };
    const args = {
      ...scope,
      enabled: true,
      body: original,
      headers,
      translatedResponse: response,
      streamStatus: 200,
      streamResponseBody: response,
    };
    storeSemanticCacheResponse(args, deps);
    storeStreamingSemanticCacheResponse(args, deps);
  }
  assert.deepEqual(await store.getStats(), before);
});

test("caller namespaces and fuzzy-only requests cannot fall through to unscoped legacy entries", async () => {
  const { manager } = await setup();
  for (const headers of [
    { "x-omniroute-cache-key": "namespace-a" },
    { "x-omniroute-cache-type": "semantic" },
  ]) {
    assert.equal(canUseLegacyResponseCache(headers), false);
    const args = {
      ...scope,
      enabled: true,
      body: original,
      headers,
      translatedResponse: response,
      streamStatus: 200,
      streamResponseBody: response,
    };
    const deps = {
      isCacheableForWrite,
      isSmallEnoughForSemanticCache: () => true,
      generateSignature,
      setCachedResponse: () => {
        throw new Error("Scoped response entered the legacy cache");
      },
    };
    storeSemanticCacheResponse(args, deps);
    storeStreamingSemanticCacheResponse(args, deps);
  }
  const headers = { "x-omniroute-cache-key": "namespace-a" };
  await manager.store({ ...scope, body: original, headers, response });
  assert.equal((await manager.lookup({ ...scope, body: original, headers })).type, "exact");
  assert.equal(
    (
      await manager.lookup({
        ...scope,
        body: original,
        headers: { "x-omniroute-cache-key": "namespace-b" },
      })
    ).hit,
    false
  );
});
