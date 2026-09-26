import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getAllSystemOneModels } from "../../open-sse/config/systemOneRegistry.ts";
import { generateModels } from "../../open-sse/config/providerRegistry.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-systemone-catalog-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "systemone-catalog-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const catalog = await import("../../src/app/api/v1/models/catalog.ts");
const infoRoute = await import("../../src/app/api/v1/models/info/route.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("JEV seeds belong to the decision catalog, not PROVIDER_MODELS", () => {
  const chatModels = generateModels();
  assert.equal(chatModels.jev, undefined);
  assert.ok(
    getAllSystemOneModels().some(
      (model) => model.id === "typesafe-ai/jev-latest" && model.provider === "typesafe-ai"
    )
  );
  assert.ok(getAllSystemOneModels().some((model) => model.id === "opencode/jev-1.13-free"));
});

test("/v1/models lists JEV once as systemone, not as chat", async () => {
  catalog.__resetCatalogBuilderRunsForTest();
  const cacheDir = path.join(TEST_DATA_DIR, "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, "openrouter-catalog.json"),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      data: [
        { id: "typesafe/jev-1.13", name: "JEV" },
        { id: "openai/gpt-4o-mini", name: "GPT-4o mini" },
      ],
    })
  );
  await providersDb.createProviderConnection({
    provider: "typesafe-ai",
    authType: "apikey",
    name: "typesafe-catalog",
    apiKey: "typesafe-test-key",
    isActive: true,
    testStatus: "active",
  });
  const openrouter = await providersDb.createProviderConnection({
    provider: "openrouter",
    authType: "apikey",
    name: "openrouter-catalog",
    apiKey: "openrouter-test-key",
    isActive: true,
    testStatus: "active",
  });
  await modelsDb.replaceSyncedAvailableModelsForConnection("openrouter", openrouter.id, [
    { id: "typesafe/jev-1.13", name: "JEV", supportedEndpoints: ["chat"] },
    { id: "openai/gpt-4o-mini", name: "GPT-4o mini", supportedEndpoints: ["chat"] },
  ]);

  const response = await catalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Array<{ id: string; type?: string }> };
  for (const id of ["typesafe-ai/jev-latest", "openrouter/typesafe/jev-1.13"]) {
    const entries = body.data.filter((model) => model.id === id);
    assert.equal(entries.length, 1, id);
    assert.equal(entries[0].type, "systemone", id);
  }
  assert.ok(body.data.some((model) => model.id.includes("openai/gpt-4o-mini")));

  const infoResponse = await infoRoute.GET(
    new Request("http://localhost/api/v1/models/info?id=typesafe-ai%2Fjev-latest&kind=systemone")
  );
  assert.equal(infoResponse.status, 200);
  const info = (await infoResponse.json()) as { kind: string; endpoint: string };
  assert.equal(info.kind, "systemone");
  assert.equal(info.endpoint, "/v1/systemone");

  const missing = await infoRoute.GET(
    new Request("http://localhost/api/v1/models/info?id=typesafe-ai%2Fhidden-jev")
  );
  assert.equal(missing.status, 404);
  const invalid = await infoRoute.GET(new Request("http://localhost/api/v1/models/info"));
  assert.equal(invalid.status, 400);
});
