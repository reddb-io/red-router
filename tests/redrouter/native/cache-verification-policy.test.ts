import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
const directory = mkdtempSync(join(tmpdir(), "redrouter-cache-verification-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const { verifySemanticCacheCandidate } =
  await import("../../../src/sse/services/semanticCacheVerification.ts");
const { createApiKey, updateApiKeyPermissions } = await import("../../../src/lib/db/apiKeys.ts");
const { createProviderConnection } = await import("../../../src/lib/db/providers.ts");
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { DEFAULT_SEMANTIC_CACHE_CONFIG } =
  await import("../../../open-sse/config/semanticCacheConfig.ts");
const { GET, PUT } = await import("../../../src/app/api/settings/cache-config/route.ts");
type Dependencies = NonNullable<Parameters<typeof verifySemanticCacheCandidate>[4]>;
const model = "openrouter/typesafe/jev-1.13";
const config = {
  ...DEFAULT_SEMANTIC_CACHE_CONFIG,
  verificationEnabled: true,
  verificationConnectionId: "decision",
  verificationModel: model,
};
const input = {
  state: {
    context: "context",
    cachedQuestion: "before",
    currentQuestion: "after",
    cachedAnswer: "answer",
  },
  entry: {
    id: "cached",
    hash: "hash",
    promptText: "before",
    model: "s2",
    provider: "openrouter",
    response: {},
    tokensSaved: 10,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60000,
  },
};
after(() => {
  resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});
function request(method: string, body?: unknown) {
  return new Request("http://localhost/api/settings/cache-config", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as never;
}
function setup(extra: Dependencies = {}) {
  const dispatches: Parameters<NonNullable<Dependencies["dispatch"]>>[] = [];
  const deps: Dependencies = {
    options: async () => [
      {
        id: "decision",
        name: "Decision",
        provider: "openrouter",
        models: [{ id: model, name: "JEV" }],
      },
    ],
    dispatch: async (...args) => {
      dispatches.push(args);
      return {
        response: Response.json({
          answers: { reusable: { type: "noul", noul: 0.99 } },
          usage: { input_tokens: 20, output_tokens: 0 },
        }),
        accountingSucceeded: true,
      };
    },
    cost: async () => ({ costUsd: 0.001, priced: true }),
    ...extra,
  };
  return { deps, dispatches };
}

test("configuration validates connection/model pairs and can always disable verified reuse", async () => {
  const connection = await createProviderConnection({
    provider: "openrouter",
    name: "Cache decisions",
    apiKey: "test-only",
    authType: "apikey",
    isActive: true,
  });
  const enabled = {
    semanticCacheEnabled: true,
    semanticCacheVectorEnabled: true,
    semanticCacheVerificationEnabled: true,
    semanticCacheVerificationConnectionId: connection.id,
    semanticCacheVerificationModel: model,
  };
  assert.equal((await PUT(request("PUT", enabled))).status, 200);
  let body = await (await GET(request("GET"))).json();
  assert.equal(body.semanticCacheVerificationEnabled, true);
  assert.equal(body.semanticCacheVerificationModel, model);
  assert.ok(body.verificationOptions.some((item: { id: string }) => item.id === connection.id));
  assert.ok(!JSON.stringify(body.verificationOptions).includes("test-only"));
  assert.equal(
    (await PUT(request("PUT", { semanticCacheVerificationModel: "openrouter/chat-model" }))).status,
    400
  );
  assert.equal(
    (await PUT(request("PUT", { semanticCacheVerificationTimeoutMs: 9000 }))).status,
    400
  );
  assert.equal((await PUT(request("PUT", { modelCatalogCacheTtlMs: 2000 }))).status, 200);
  assert.equal(
    (
      await PUT(
        request("PUT", {
          semanticCacheEnabled: false,
          semanticCacheVerificationConnectionId: "deleted",
        })
      )
    ).status,
    200
  );
  body = await (await GET(request("GET"))).json();
  assert.equal(body.semanticCacheEnabled, false);
  assert.equal((await PUT(request("PUT", { semanticCacheEnabled: true }))).status, 400);
  assert.equal(
    (
      await PUT(
        request("PUT", {
          semanticCacheVerificationEnabled: false,
          semanticCacheVectorEnabled: false,
        })
      )
    ).status,
    200
  );
});

test("client key model, connection, endpoint and quota restrictions gate auxiliary decisions", async () => {
  const key = await createApiKey("Cache user", "test-machine");
  const { deps, dispatches } = setup();
  const evaluate = () =>
    verifySemanticCacheCandidate(
      input,
      config,
      { apiKeyId: key.id },
      new AbortController().signal,
      deps
    );
  assert.equal((await evaluate()).outcome, "accepted");
  assert.equal(dispatches[0][2]?.forcedConnectionId, "decision");
  assert.equal(dispatches[0][2]?.apiKeyId, key.id);
  assert.deepEqual(dispatches[0][1].state, input.state);
  for (const patch of [
    { allowedConnections: ["other"] },
    { allowedConnections: [], blockedModels: [model] },
    { blockedModels: [], allowedEndpoints: ["chat"] },
    { allowedEndpoints: [], allowedQuotas: ["missing-pool"] },
    { allowedQuotas: [], isActive: false },
  ]) {
    await updateApiKeyPermissions(key.id, patch);
    assert.equal((await evaluate()).outcome, "unavailable");
  }
  assert.equal(dispatches.length, 1);
});

test("budget/accounting failure, malformed response and low confidence cannot serve a cache hit", async () => {
  for (const [answer, accounted, status, expected] of [
    [{ type: "noul", noul: 0.99 }, false, 200, "unavailable"],
    [{ type: "noul", noul: "0.99" }, true, 200, "unavailable"],
    [{ type: "noul", noul: 0.8 }, true, 200, "rejected"],
    [{ type: "noul", noul: 0.99 }, false, 429, "unavailable"],
  ] as const) {
    const { deps } = setup({
      dispatch: async () => ({
        response: Response.json({ answers: { reusable: answer } }, { status }),
        accountingSucceeded: accounted,
      }),
    });
    assert.equal(
      (await verifySemanticCacheCandidate(input, config, {}, new AbortController().signal, deps))
        .outcome,
      expected
    );
  }
});
