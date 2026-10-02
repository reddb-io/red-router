import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "rr-models-dev-seed-"));
process.env.DATA_DIR = directory;
const { resetDbInstance, getDbInstance } = await import("../../../src/lib/db/core.ts");
const seed = await import("../../../src/lib/catalog/modelsDevSeed.ts");
const { getSyncedCapability } = await import("../../../src/lib/modelsDevSync.ts");
const { normalizeCatalog } = await import("../../../scripts/research/update-models-dev-seed.mjs");
const { enrichCatalogModelEntry } = await import("../../../src/lib/modelMetadataRegistry.ts");
const { updatePricing, getPricingForModel, getCatalogPricingSnapshot } =
  await import("../../../src/lib/db/settings/pricing.ts");
after(() => {
  resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});

test("bundled metadata has a verified content hash, exact native IDs and decision taxonomy", () => {
  const raw = JSON.parse(
    readFileSync(new URL("../../../src/lib/catalog/modelsDevSeed.json", import.meta.url), "utf8")
  );
  const hash = createHash("sha256")
    .update(JSON.stringify({ providers: raw.providers, models: raw.models }))
    .digest("hex");
  assert.equal(hash, seed.getBundledModelsDevManifest().contentSha256);
  const opus = seed.getBundledModelsDevCapability("openrouter", "anthropic/claude-opus-4.6");
  assert.equal(opus?.native_model_id, "anthropic/claude-opus-4.6");
  assert.equal(opus?.canonical_model_id, "anthropic/claude-opus-4-6");
  assert.equal(opus?.metadata_source, "models-dev-bundled");
  assert.ok(Array.isArray(JSON.parse(opus?.reasoning_options || "null")));
  assert.equal(seed.getBundledModelsDevCapability("opencode", "jev-1.13")?.model_type, "decision");
  assert.equal(seed.getBundledModelsDevCapability("openrouter", "claude-opus-4.6"), null);
});

test("offline first reads provide metadata without network, connections, model activation or sync writes", () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Offline fixture must not fetch");
  };
  try {
    assert.equal(
      getSyncedCapability("openrouter", "anthropic/claude-opus-4.6")?.metadata_source,
      "models-dev-bundled"
    );
    const db = getDbInstance();
    const count = db.prepare("SELECT COUNT(*) AS count FROM provider_connections").get() as {
      count: number;
    };
    assert.equal(count.count, 0);
    const snapshot = db
      .prepare("SELECT COUNT(*) AS count FROM key_value WHERE namespace = 'models_dev_snapshot'")
      .get() as { count: number };
    assert.equal(snapshot.count, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("normalization is reproducible and strips executable provider configuration", () => {
  const native = "karavela/vendor/model@2026:variant";
  const fixture = {
    providers: {
      karavela: {
        id: "karavela",
        name: "Karavela",
        api: "https://secret.invalid",
        env: ["SECRET"],
        models: {
          [native]: {
            id: native,
            name: "Fixture",
            provider: { body: { api_key: "secret" } },
            reasoning: true,
            reasoning_options: [{ type: "effort", values: [null, "low"] }],
          },
        },
      },
    },
    models: {},
  };
  const normalized = normalizeCatalog(fixture);
  assert.equal(normalized.providers.karavela.models[native].id, native);
  assert.deepEqual(normalized, normalizeCatalog(JSON.parse(JSON.stringify(fixture))));
  assert.equal(JSON.stringify(normalized).includes("secret"), false);
  assert.throws(() =>
    normalizeCatalog({
      ...fixture,
      providers: { karavela: { ...fixture.providers.karavela, id: "different" } },
    })
  );
});

test("user prices agree between catalog and estimation, without native ID or endpoint rewriting", async () => {
  const model = "anthropic/claude-opus-4.6";
  const entry = {
    id: `openrouter/${model}`,
    root: model,
    owned_by: "openrouter",
    supported_endpoints: ["chat/completions"],
    pricing: { input: 7, output: 30 },
  };
  await updatePricing({ openrouter: { [model]: { input: 99, output: 100 } } });
  const snapshot = getCatalogPricingSnapshot();
  const enriched = enrichCatalogModelEntry(
    entry,
    { provider: "openrouter", model },
    {
      modelsDevPricing: null,
      effectivePricing: snapshot.pricing,
      userPricing: snapshot.userPricing,
    }
  );
  assert.equal(enriched.id, entry.id);
  assert.equal(enriched.root, model);
  assert.deepEqual(enriched.supported_endpoints, entry.supported_endpoints);
  assert.equal(enriched.pricing.input, (await getPricingForModel("openrouter", model))?.input);
  assert.equal(enriched.pricing.input, 99);
});

test("catalog and estimation do not borrow another deployment, namespace, case or model punctuation", async () => {
  await updatePricing({
    "fixture-cn": { "vendor/model": { input: 33, output: 34 } },
    fixture: {
      model: { input: 55, output: 56 },
      "glm-4-7": { input: 77, output: 78 },
      LlamaCase: { input: 88, output: 89 },
    },
    isolated: { model: { input: 66, output: 67 } },
  });
  const snapshot = getCatalogPricingSnapshot();
  const enriched = enrichCatalogModelEntry(
    { id: "fixture/vendor/model", root: "vendor/model", owned_by: "fixture" },
    { provider: "fixture", model: "vendor/model" },
    {
      modelsDevPricing: null,
      effectivePricing: snapshot.pricing,
      userPricing: snapshot.userPricing,
    }
  ) as Record<string, unknown>;
  assert.equal(enriched.pricing, undefined);
  assert.equal(await getPricingForModel("fixture", "vendor/model"), null);
  assert.equal(await getPricingForModel("isolated-cn", "model"), null);
  assert.equal(await getPricingForModel("fixture", "glm-4.7"), null);
  assert.equal(await getPricingForModel("fixture", "llamacase"), null);
  assert.equal((await getPricingForModel("fixture", "glm-4-7"))?.input, 77);
  assert.equal((await getPricingForModel("fixture", "LlamaCase"))?.input, 88);
  assert.equal((await getPricingForModel("fixture-cn", "vendor/model"))?.input, 33);
});
