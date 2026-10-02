import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "redrouter-decision-feeds-"));
process.env.DATA_DIR = dir;
process.env.INITIAL_PASSWORD = "";
process.env.REQUIRE_API_KEY = "true";
process.env.OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS = "true";
const feeds = await import("../../../src/lib/providerModels/openrouterModelFeeds.ts");
const { normalizeDiscoveredModels } =
  await import("../../../src/lib/providerModels/modelDiscovery.ts");
const { normalizeSyncedAvailableModels } = await import("../../../src/lib/db/models/synced.ts");
const { isChatSelectableModel } = await import("../../../open-sse/services/modelEndpointPolicy.ts");
const { resolveSystemOneTarget, forwardSystemOne } =
  await import("../../../open-sse/handlers/systemOneCore.ts");
const { getOpenRouterCatalog, refreshOpenRouterCatalog } =
  await import("../../../src/lib/catalog/openrouterCatalog.ts");
const providers = await import("../../../src/lib/db/providers.ts");
const models = await import("../../../src/lib/db/models.ts");
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
const { GET: manageModels } = await import("../../../src/app/api/providers/[id]/models/route.ts");
const { GET: catalog } = await import("../../../src/app/api/v1/models/route.ts");
const { POST: evaluate } = await import("../../../src/app/api/v1/systemone/route.ts");
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});
const chat = { id: "vendor/chat", architecture: { output_modalities: ["text"] } };
const decisions = ["~typesafe/jev-latest", "typesafe/jev-1.13", "liquid/d1"].map((id) => ({
  id,
  architecture: { input_modalities: ["text"], output_modalities: ["decisions"] },
  supported_parameters: [],
}));

test("separate public decision feed retains literal IDs and excludes unknown protocols from S1/S2", async () => {
  const urls: string[] = [];
  const rows = await feeds.fetchOpenRouterModelFeeds(
    "https://openrouter.ai/api/v1/models",
    async (url) => {
      urls.push(String(url));
      return Response.json({
        data: String(url).includes("output_modalities=decisions") ? decisions : [chat],
      });
    }
  );
  assert.deepEqual(urls.sort(), [
    "https://openrouter.ai/api/v1/models",
    "https://openrouter.ai/api/v1/models?output_modalities=decisions",
  ]);
  const normalized = normalizeSyncedAvailableModels(
    normalizeDiscoveredModels(rows, "openrouter"),
    "openrouter"
  );
  const latest = normalized.find((model) => model.id === "~typesafe/jev-latest")!;
  assert.equal(latest.nativeModelId, "~typesafe/jev-latest");
  assert.deepEqual([...latest.supportedEndpoints!].sort(), ["decisions", "systemone"]);
  for (const model of normalized.filter((model) => model.modelType === "decision")) {
    assert.equal(isChatSelectableModel("openrouter", model), false);
  }
  const unsupported = normalized.find((model) => model.id === "liquid/d1")!;
  assert.deepEqual(unsupported.supportedEndpoints, []);
  assert.equal(unsupported.apiFormat, "decision-native");
  assert.equal(resolveSystemOneTarget("openrouter/liquid/d1"), null);
  await assert.rejects(
    feeds.fetchOpenRouterDecisionModels("https://openrouter.ai/api/v1/models", async () =>
      Response.json({ data: [chat] })
    )
  );
});

test("historical unsupported JEV names never become chat, and remote/custom endpoints retain their declaration", () => {
  const legacy = normalizeDiscoveredModels(
    ["typesafe/jev-latest", "typesafe/jev-preview"].map((id) => ({
      id,
      supportedEndpoints: ["chat"],
    })),
    "openrouter"
  );
  for (const model of legacy) {
    assert.equal(model.modelType, "decision");
    assert.deepEqual(model.supportedEndpoints, []);
    assert.equal(isChatSelectableModel("openrouter", model), false);
    assert.equal(resolveSystemOneTarget(`openrouter/${model.id}`), null);
    assert.equal(
      isChatSelectableModel("openrouter", { ...model, supportedEndpoints: ["chat"] }),
      false
    );
  }
  assert.equal(resolveSystemOneTarget("openrouter/jev-latest")?.model, "typesafe/jev-1.13");
  for (const provider of ["red-router", "compatible-fixture"]) {
    const [model] = normalizeDiscoveredModels(
      [
        {
          id: "red/openrouter/typesafe/jev-latest",
          type: "systemone",
          supportedEndpoints: ["/v1/decisions"],
        },
      ],
      provider
    );
    assert.deepEqual(model.supportedEndpoints, ["/v1/decisions"]);
    assert.equal(model.id, "red/openrouter/typesafe/jev-latest");
  }
});

test("global metadata cache upgrades old chat-only snapshots and never commits a partial feed as complete", async () => {
  mkdirSync(join(dir, "cache"), { recursive: true });
  const cachePath = join(dir, "cache/openrouter-catalog.json");
  writeFileSync(cachePath, JSON.stringify({ fetchedAt: new Date().toISOString(), data: [chat] }));
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return Response.json({
      data: String(url).includes("output_modalities=decisions") ? decisions : [chat],
    });
  };
  const fresh = await getOpenRouterCatalog();
  assert.equal(fresh.fromCache, false);
  assert.equal(
    fresh.data.some((row) => row.id === "~typesafe/jev-latest"),
    true
  );
  assert.equal(requests, 2);
  await getOpenRouterCatalog();
  assert.equal(requests, 2);
  const originalCache = readFileSync(cachePath, "utf8");
  globalThis.fetch = async (url) =>
    String(url).includes("output_modalities=decisions")
      ? Response.json({}, { status: 503 })
      : Response.json({ data: [chat] });
  assert.equal((await refreshOpenRouterCatalog()).ok, false);
  assert.equal(readFileSync(cachePath, "utf8"), originalCache);
  globalThis.fetch = originalFetch;
});

test("connection discovery, opt-in, key-scoped S1 and configured upstream preserve URL/key/native model/payload", async () => {
  await updateSettings({ requireLogin: false, hideAutoCombos: true, hidePaidModels: false });
  const connection = await providers.createProviderConnection({
    provider: "openrouter",
    authType: "apikey",
    apiKey: "selected-upstream-fixture",
    isActive: false,
    providerSpecificData: {
      baseUrl: "https://regional.example/api/v1/chat/completions",
      autoFetchModels: false,
    },
  });
  const id = String(connection.id);
  const manager = await createApiKey("Manager", "tests", ["manage"]);
  const client = await createApiKey("S1", "tests", [], {
    allowedConnections: [id],
    allowedModels: ["openrouter/~typesafe/jev-latest"],
    modelAccessMode: "restricted",
  });
  const managementRequest = (query: string) =>
    new Request(`http://localhost/api/providers/${id}/models?${query}`, {
      headers: { authorization: `Bearer ${manager.key}` },
    });
  const sends: string[] = [];
  globalThis.fetch = async (url, init) => {
    sends.push(String(url));
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer selected-upstream-fixture"
    );
    return Response.json({
      data: String(url).includes("output_modalities=decisions") ? decisions : [chat],
    });
  };
  const discovered = await manageModels(managementRequest("refresh=true"), { params: { id } });
  assert.equal(discovered.status, 200, await discovered.clone().text());
  assert.deepEqual(sends.sort(), [
    "https://regional.example/api/v1/models",
    "https://regional.example/api/v1/models?output_modalities=decisions",
  ]);
  assert.equal((await providers.getProviderConnectionById(id))?.isActive, false);
  const inventory = await models.getSyncedAvailableModelsForConnection("openrouter", id);
  assert.equal(
    inventory.some((row) => row.id === "liquid/d1" && row.modelType === "decision"),
    true
  );
  const selected = await manageModels(managementRequest("capabilities=decision"), {
    params: { id },
  });
  const selectable = (await selected.json()).models as Array<{ fullModel: string }>;
  assert.equal(
    selectable.some((row) => row.fullModel === "openrouter/~typesafe/jev-latest"),
    true
  );
  assert.equal(
    selectable.some((row) => row.fullModel.includes("liquid")),
    false
  );
  const published = async () => {
    const response = await catalog(
      new Request("http://localhost/v1/models?capabilities=decision", {
        headers: { authorization: `Bearer ${client.key}` },
      })
    );
    assert.equal(response.status, 200);
    return ((await response.json()).data as Array<{ id: string }>).map((row) => row.id);
  };
  assert.deepEqual(await published(), []);
  await providers.updateProviderConnection(id, { isActive: true });
  assert.deepEqual(await published(), [], "catalog membership never activates a model");
  await models.setModelActivation("openrouter", "~typesafe/jev-latest", true);
  assert.deepEqual(await published(), ["openrouter/~typesafe/jev-latest"]);
  const unrestricted = await createApiKey("Unrestricted inventory fixture", "tests", [], {
    allowedConnections: [id],
  });
  await models.setModelActivation("openrouter", "liquid/d1", true);
  await models.setModelActivation("openrouter", "vendor/chat", true);
  const unsupportedCustom = {
    id: "respan/unsupported-decision",
    modelType: "decision",
    apiFormat: "decision-native",
    supportedEndpoints: ["systemone"],
    source: "manual",
  };
  await models.replaceCustomModels("openrouter", [unsupportedCustom]);
  await models.setModelActivation("openrouter", unsupportedCustom.id, true);
  for (const role of ["chat", "decision"]) {
    const response = await catalog(
      new Request(`http://localhost/v1/models?capabilities=${role}`, {
        headers: { authorization: `Bearer ${unrestricted.key}` },
      })
    );
    assert.equal(response.status, 200);
    const ids = ((await response.json()).data as Array<{ id: string }>).map((row) => row.id);
    assert.equal(ids.includes("openrouter/liquid/d1"), false);
    assert.equal(ids.includes(`openrouter/${unsupportedCustom.id}`), false);
    assert.equal(
      ids.includes(role === "chat" ? "openrouter/vendor/chat" : "openrouter/~typesafe/jev-latest"),
      true
    );
  }
  assert.equal(
    (await models.getSyncedAvailableModelsForConnection("openrouter", id)).some(
      (row) => row.id === "liquid/d1"
    ),
    true
  );
  assert.equal(
    (await models.getCustomModels("openrouter")).some((row) => row.id === unsupportedCustom.id),
    true
  );
  const body = {
    model: "openrouter/~typesafe/jev-latest",
    state: { text: "Ready" },
    questions: { ready: { type: "noul" } },
    extension: { preserve: true },
  };
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://regional.example/api/v1/systemone");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer selected-upstream-fixture"
    );
    assert.deepEqual(JSON.parse(String(init?.body)), { ...body, model: "~typesafe/jev-latest" });
    return Response.json({ answers: { ready: { type: "noul", noul: 0.99 } } });
  };
  const result = await evaluate(
    new Request("http://localhost/v1/systemone", {
      method: "POST",
      headers: { authorization: `Bearer ${client.key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  assert.equal(result.status, 200, await result.clone().text());
  globalThis.fetch = async (url) =>
    String(url).includes("output_modalities=decisions")
      ? Response.json({}, { status: 503 })
      : Response.json({ data: [chat] });
  const partial = await manageModels(managementRequest("refresh=true"), { params: { id } });
  assert.equal((await partial.json()).decisionCatalogStale, true);
  assert.equal(
    (await models.getSyncedAvailableModelsForConnection("openrouter", id)).some(
      (row) => row.id === "~typesafe/jev-latest"
    ),
    true
  );
  globalThis.fetch = originalFetch;
});

test("a dead assigned proxy pool refuses both discovery feeds before any credential-bearing egress", async () => {
  await updateSettings({ requireLogin: false, proxyEnabled: true });
  const proxies = await import("../../../src/lib/db/proxies.ts");
  const connection = await providers.createProviderConnection({
    provider: "openrouter",
    authType: "apikey",
    apiKey: "proxy-blocked-credential",
    isActive: true,
    proxyEnabled: true,
    providerSpecificData: { baseUrl: "https://blocked.example/api/v1", autoFetchModels: true },
  });
  const id = String(connection.id);
  const first = await proxies.createProxy({
    name: "Dead discovery pool A",
    type: "http",
    host: "10.0.0.21",
    port: 9021,
    status: "inactive",
  });
  const second = await proxies.createProxy({
    name: "Dead discovery pool B",
    type: "http",
    host: "10.0.0.22",
    port: 9022,
    status: "error",
  });
  await proxies.addProxyToScopePool("account", id, first!.id);
  await proxies.addProxyToScopePool("account", id, second!.id);
  await models.replaceSyncedAvailableModelsForConnection("openrouter", id, [
    {
      id: "vendor/cached-chat",
      name: "Cached chat",
      source: "imported",
      supportedEndpoints: ["chat"],
    },
  ]);
  const manager = await createApiKey("Dead-pool manager", "tests", ["manage"]);
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("must not attempt direct discovery");
  };
  try {
    const cached = await manageModels(
      new Request(`http://localhost/api/providers/${id}/models`, {
        headers: { authorization: `Bearer ${manager.key}` },
      }),
      { params: { id } }
    );
    assert.equal(cached.status, 200);
    assert.equal(
      ((await cached.json()).models as Array<{ id: string }>).some(
        (model) => model.id === "vendor/cached-chat"
      ),
      true
    );
    assert.equal(requests, 0);
    const response = await manageModels(
      new Request(`http://localhost/api/providers/${id}/models?refresh=true`, {
        headers: { authorization: `Bearer ${manager.key}` },
      }),
      { params: { id } }
    );
    assert.equal(response.status, 503);
    assert.equal(requests, 0);
    const error = await response.json();
    assert.equal(JSON.stringify(error).includes("proxy-blocked-credential"), false);
    assert.equal(error.error.message.includes("at /"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("federation removes exactly one local hop while preserving tilde ID and typed payload", async () => {
  const target = resolveSystemOneTarget("red/red/openrouter/~typesafe/jev-latest")!;
  assert.equal(target.model, "red/openrouter/~typesafe/jev-latest");
  const body = {
    state: { text: "Ready" },
    questions: { ready: { type: "noul" } },
    extension: true,
  };
  const result = await forwardSystemOne(target, "remote-router-key", body, {
    fetchImpl: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer remote-router-key");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        ...body,
        model: "red/openrouter/~typesafe/jev-latest",
      });
      return Response.json({ answers: { ready: { noul: 1 } } });
    },
  });
  assert.equal(result.response.status, 200);
  assert.equal(
    resolveSystemOneTarget("openrouter/~typesafe/jev-latest")?.url,
    "https://openrouter.ai/api/v1/systemone"
  );
  assert.equal(
    feeds.configuredOpenRouterModelsUrl({
      customBaseUrl: "https://custom.example/api/v1/responses?request-only=true",
    }),
    "https://custom.example/api/v1/models"
  );
});
