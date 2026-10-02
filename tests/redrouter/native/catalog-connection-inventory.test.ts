import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "redrouter-catalog-inventory-"));
process.env.DATA_DIR = dir;
process.env.REQUIRE_API_KEY = "true";
process.env.INITIAL_PASSWORD = "";
const core = await import("../../../src/lib/db/core.ts");
const providers = await import("../../../src/lib/db/providers.ts");
const models = await import("../../../src/lib/db/models.ts");
const keys = await import("../../../src/lib/db/apiKeys.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { GET: catalog } = await import("../../../src/app/api/v1/models/route.ts");
const { GET: capabilities } = await import("../../../src/app/api/v1/capabilities/route.ts");
const { commitRemoteRouterCatalog } = await import("../../../src/lib/db/remoteRouterCatalog.ts");
const { remoteRouterSnapshot } =
  await import("../../../src/lib/providerModels/remoteRouterCatalog.ts");
const { getAllActiveSyncedModels } =
  await import("../../../src/lib/db/models/activeSyncedCatalog.ts");
const { findPublishedModel } = await import("../../../src/lib/db/apiKeys/publishedModelLookup.ts");
const learned = await import("../../../open-sse/services/learnedReasoningEffortCaps.ts");

after(() => {
  learned.__test_resetLearnedReasoningEffortCaps();
  core.resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});
const request = (path: string, key: string) =>
  new Request(`http://localhost/v1/${path}`, { headers: { authorization: `Bearer ${key}` } });
async function list(key: string, role: string) {
  const response = await catalog(request(`models?capabilities=${role}`, key));
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()).data as { id: string }[]).map((row) => row.id).sort();
}

test("two keys with same-provider connections see only their own chat and decision inventories", async () => {
  await updateSettings({
    requireLogin: false,
    hideAutoCombos: true,
    hideNoThinkVariants: true,
    transparentModels: true,
  });
  const create = async (name: string) => {
    const connection = await providers.createProviderConnection({
      provider: "red-router",
      authType: "apikey",
      apiKey: `${name}-credential`,
      isActive: true,
      providerSpecificData: { baseUrl: `https://${name}.example/v1`, autoFetchModels: false },
    });
    const snapshot = remoteRouterSnapshot(connection);
    assert.equal(
      commitRemoteRouterCatalog(snapshot, {
        fingerprint: snapshot.fingerprint,
        syncedAt: Date.now(),
        models: [
          { id: `vendor/${name}-chat`, type: "chat", capabilities: { chat: true } },
          {
            id: `red/openrouter/typesafe/jev-${name}`,
            type: "systemone",
            supported_endpoints: ["decisions"],
            capabilities: { decision: true },
          },
        ],
      }),
      true
    );
    for (const id of [`vendor/${name}-chat`, `red/openrouter/typesafe/jev-${name}`]) {
      await models.setModelActivation("red-router", id, true);
    }
    const key = await keys.createApiKey(name, "tests", [], {
      allowedConnections: [String(connection.id)],
    });
    return { connection, key };
  };
  const first = await create("first");
  const second = await create("second");
  for (const [name, fixture] of [
    ["first", first],
    ["second", second],
  ] as const) {
    assert.deepEqual(await list(fixture.key.key, "chat"), [`red/vendor/${name}-chat`]);
    const decisionIds = [`red/red/openrouter/typesafe/jev-${name}`];
    assert.deepEqual(await list(fixture.key.key, "decision"), decisionIds);
    const discovery = await capabilities(request("capabilities", fixture.key.key));
    assert.equal(discovery.status, 200);
    assert.deepEqual((await discovery.json()).systemone.models, decisionIds);
  }
  assert.deepEqual(await getAllActiveSyncedModels([]), {}, "an empty scope never becomes global");

  await providers.updateProviderConnection(String(first.connection.id), {
    providerSpecificData: {
      ...(first.connection.providerSpecificData as Record<string, unknown>),
      excludedModels: ["vendor/first-chat"],
    },
  });
  assert.deepEqual(await list(first.key.key, "chat"), []);
  assert.deepEqual(await list(second.key.key, "chat"), ["red/vendor/second-chat"]);
  await providers.updateProviderConnection(String(first.connection.id), { isActive: false });
  assert.deepEqual(await list(first.key.key, "decision"), []);
  assert.deepEqual(await list(second.key.key, "decision"), [
    "red/red/openrouter/typesafe/jev-second",
  ]);
});

test("public compatible catalog preserves a native namespace equal to the local routing prefix", async () => {
  await updateSettings({
    requireLogin: false,
    hideAutoCombos: true,
    hideNoThinkVariants: true,
    transparentModels: true,
  });
  const node = await providers.createProviderNode({
    id: "public-native-fixture",
    type: "openai-compatible",
    prefix: "karavela",
    name: "Karavela",
    baseUrl: "https://compatible.example/v1",
  });
  const provider = String(node.id);
  const connection = await providers.createProviderConnection({
    provider,
    authType: "apikey",
    apiKey: "compatible-credential",
    isActive: true,
    providerSpecificData: { autoFetchModels: false },
  });
  const native = "karavela/glm-5.3-flash";
  await models.replaceSyncedAvailableModelsForConnection(provider, String(connection.id), [
    {
      id: native,
      nativeModelId: native,
      name: "GLM",
      source: "imported",
      supportedEndpoints: ["chat"],
    },
  ]);
  await models.setModelActivation(provider, native, true);
  const key = await keys.createApiKey("Native namespace", "tests", [], {
    allowedConnections: [String(connection.id)],
  });
  const response = await catalog(request("models?capabilities=chat", key.key));
  assert.equal(response.status, 200, await response.clone().text());
  const rows = (await response.json()).data as { id: string; root: string }[];
  assert.deepEqual(
    rows.map((row) => row.id),
    [`karavela/${native}`]
  );
  assert.equal(rows[0].root, native);
});

test("an aliased effort variant uses the real provider's learned contract in published-model ACLs", async () => {
  learned.__test_resetLearnedReasoningEffortCaps();
  await models.replaceSyncedAvailableModelsForConnection("grok-cli", "grok-effort-acl", [
    {
      id: "grok-private",
      name: "Private reasoner",
      source: "imported",
      supportedThinkingEfforts: ["low", "medium", "high"],
    },
  ]);
  learned.recordLearnedReasoningEffort("grok-cli", "grok-private", ["low"]);
  learned.recordLearnedReasoningEffort("other-gateway", "grok-private", ["high"]);
  assert.deepEqual(await findPublishedModel("gc", "grok-private-low"), {
    providerId: "grok-cli",
    publishedModelId: "grok-private",
  });
  assert.equal(await findPublishedModel("gc", "grok-private-high"), null);

  const key = await keys.createApiKey("Aliased efforts", "tests");
  await keys.updateApiKeyPermissions(key.id, { disableNonPublicModels: true });
  assert.equal(await keys.isModelAllowedForKey(key.key, "gc/grok-private-low"), false);
  // Discovery is not activation: publish the base model explicitly before
  // verifying that the permitted alias uses this provider's learned enum.
  await models.setModelActivation("grok-cli", "grok-private", true);
  assert.equal(await keys.isModelAllowedForKey(key.key, "gc/grok-private-low"), true);
  assert.equal(await keys.isModelAllowedForKey(key.key, "gc/grok-private-high"), false);
  await keys.updateApiKeyPermissions(key.id, { blockedModels: ["grok-cli/grok-private"] });
  assert.equal(await keys.isModelAllowedForKey(key.key, "gc/grok-private-low"), false);
});
