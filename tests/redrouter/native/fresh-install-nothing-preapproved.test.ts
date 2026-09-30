import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Acceptance test for "nothing comes pre-approved": an empty install (scratch DATA_DIR, no
// connections, no settings) exposes no models, enables no provider and resolves no credentials.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-fresh-install-"));
process.env.DATA_DIR = dataDir;
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { AI_PROVIDERS } = await import("../../../src/shared/constants/providers.ts");
const { getProviderCredentials } = await import("../../../src/sse/services/auth.ts");
const { GET: getV1Models } = await import("../../../src/app/api/v1/models/route.ts");
const { GET: getModelCatalog } = await import("../../../src/app/api/models/catalog/route.ts");
const { GET: getProviders } = await import("../../../src/app/api/providers/route.ts");
const { getComboBuilderOptions } = await import("../../../src/lib/combos/builderOptions.ts");
const { getSettings } = await import("../../../src/lib/db/settings.ts");

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

test("a fresh install lists zero models on /v1/models", async () => {
  const response = await getV1Models(new Request("http://localhost/v1/models"));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Array<{ id: string }> };
  assert.deepEqual(
    body.data.map((model) => model.id),
    []
  );
});

test("a fresh install lists zero models in the dashboard models catalog", async () => {
  const response = await getModelCatalog(new Request("http://localhost/api/models/catalog"));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { catalog: Record<string, unknown> };
  assert.deepEqual(Object.keys(body.catalog), []);
});

test("a fresh install enables no provider", async () => {
  assert.deepEqual((await getSettings()).enabledNoAuthProviders, []);
  const response = await getProviders(new Request("http://localhost/api/providers"));
  const body = (await response.json()) as {
    connections: unknown[];
    providerAvailability: Record<string, { enabled: boolean; kind: string }>;
  };
  assert.deepEqual(body.connections, []);
  const ids = Object.keys(body.providerAvailability);
  assert.ok(ids.length > 100, "every registry provider is described");
  for (const id of ids) {
    assert.deepEqual(body.providerAvailability[id], { enabled: false, kind: "available" }, id);
  }
});

test("a fresh install offers no provider in the combo builder", async () => {
  const options = await getComboBuilderOptions();
  assert.deepEqual(
    options.providers.map((provider) => provider.providerId),
    []
  );
});

test("a fresh install resolves no credentials for any registry provider", async () => {
  const leaked: string[] = [];
  for (const id of Object.keys(AI_PROVIDERS)) {
    const credentials = await getProviderCredentials(id);
    if (credentials) leaked.push(id);
  }
  assert.deepEqual(leaked, []);
});
