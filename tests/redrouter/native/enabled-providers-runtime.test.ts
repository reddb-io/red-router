import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Opt-in enforcement on a scratch install: an unconfigured no-auth source has no credentials, no
// catalog models and no combo-builder entry until the operator enables it (or connects it).
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-enabled-providers-"));
process.env.DATA_DIR = dataDir;
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const { getProviderCredentials } = await import("../../../src/sse/services/auth.ts");
const { GET: getV1Models } = await import("../../../src/app/api/v1/models/route.ts");
const { GET: getModelCatalog } = await import("../../../src/app/api/models/catalog/route.ts");
const { GET: getProviders } = await import("../../../src/app/api/providers/route.ts");
const { getComboBuilderOptions } = await import("../../../src/lib/combos/builderOptions.ts");
const { isNoAuthGateOpenNow } =
  await import("../../../src/lib/providers/enabledProvidersAccessor.ts");
const { PATCH: patchSettings } = await import("../../../src/app/api/settings/route.ts");
const { getSettings } = await import("../../../src/lib/db/settings.ts");
const { ALIAS_TO_ID, ID_TO_ALIAS } = await import("../../../src/shared/constants/providers.ts");

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

const enable = (ids: string[]) => updateSettings({ enabledNoAuthProviders: ids });
const listedModels = async () => {
  const response = await getV1Models(new Request("http://localhost/v1/models"));
  return ((await response.json()) as { data: Array<{ id: string; owned_by: string }> }).data;
};
const modelsOf = (models: Array<{ id: string; owned_by: string }>, providerId: string) => {
  const prefixes = [providerId, ID_TO_ALIAS[providerId]].filter(Boolean);
  return models.filter(
    (model) =>
      prefixes.includes(model.owned_by) || prefixes.some((p) => model.id.startsWith(`${p}/`))
  );
};

test("an unconfigured no-auth provider has no credentials; enabling it restores the synthetic one", async () => {
  await enable([]);
  for (const id of ["aihorde", "uncloseai", "opencode", "mimo-free"]) {
    assert.equal(await getProviderCredentials(id), null, `${id} must not resolve credentials`);
  }
  await enable(["aihorde"]);
  const credentials = (await getProviderCredentials("aihorde")) as Record<string, unknown>;
  assert.equal(credentials.connectionId, "noauth");
  assert.equal(credentials.apiKey, null);
  assert.equal(await getProviderCredentials("uncloseai"), null, "only the enabled one opens");
  // Aliases route through the same gate.
  assert.equal(await getProviderCredentials(ID_TO_ALIAS.uncloseai ?? "uncloseai"), null);
});

test("blockedProviders still wins over an enabled no-auth provider", async () => {
  await updateSettings({ enabledNoAuthProviders: ["aihorde"], blockedProviders: ["aihorde"] });
  assert.equal(await getProviderCredentials("aihorde"), null);
  await updateSettings({ blockedProviders: [] });
  assert.ok(await getProviderCredentials("aihorde"));
});

test("a keyed provider with a connection is unaffected by the free-source list", async () => {
  await enable([]);
  const created = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "OpenAI",
    apiKey: "sk-openai-live",
    isActive: true,
    testStatus: "active",
  });
  const credentials = (await getProviderCredentials("openai")) as Record<string, unknown>;
  assert.equal(credentials.connectionId, created.id);
  assert.equal(credentials.apiKey, "sk-openai-live");
  assert.equal(await getProviderCredentials("anthropic"), null, "unconfigured keyed provider");
});

test("an anonymous-fallback gateway is gated without a connection and unaffected with one", async () => {
  await enable([]);
  await providersDb.deleteProviderConnectionsByProvider("opencode-go");
  assert.equal(await getProviderCredentials("opencode-go"), null);

  // A dead (inactive, expired) key does not count as enabling the provider either.
  await providersDb.createProviderConnection({
    provider: "opencode-go",
    authType: "apikey",
    name: "dead-key",
    apiKey: "sk-dead",
    isActive: false,
    testStatus: "expired",
  });
  const dead = (await getProviderCredentials("opencode-go")) as Record<string, unknown> | null;
  assert.notEqual(
    dead?.connectionId,
    "noauth",
    "no synthetic credential for a provider not enabled"
  );

  await enable(["opencode-go"]);
  const fallback = (await getProviderCredentials("opencode-go")) as Record<string, unknown>;
  assert.equal(fallback.connectionId, "noauth");

  await enable([]);
  await providersDb.deleteProviderConnectionsByProvider("opencode-go");
  const live = await providersDb.createProviderConnection({
    provider: "opencode-go",
    authType: "apikey",
    name: "live-key",
    apiKey: "sk-live",
    isActive: true,
    testStatus: "active",
  });
  const credentials = (await getProviderCredentials("opencode-go")) as Record<string, unknown>;
  assert.equal(credentials.connectionId, live.id);
});

test("no-auth models appear in /v1/models and the dashboard catalog only once enabled", async () => {
  await enable([]);
  assert.equal(modelsOf(await listedModels(), "aihorde").length, 0);
  const before = (await (
    await getModelCatalog(new Request("http://localhost/api/models/catalog"))
  ).json()) as { catalog: Record<string, unknown> };
  assert.equal(
    Object.keys(before.catalog).some((key) => key === "aihorde" || key === ID_TO_ALIAS.aihorde),
    false
  );

  await enable(["aihorde"]);
  const { activateCatalogFixtureInventory } =
    await import("../../helpers/modelActivationFixtures.ts");
  await activateCatalogFixtureInventory();
  assert.ok(modelsOf(await listedModels(), "aihorde").length > 0, "enabled: models are listed");
  const after = (await (
    await getModelCatalog(new Request("http://localhost/api/models/catalog"))
  ).json()) as { catalog: Record<string, unknown> };
  assert.ok(
    Object.keys(after.catalog).some((key) => key === "aihorde" || key === ID_TO_ALIAS.aihorde)
  );
  assert.equal(modelsOf(await listedModels(), "uncloseai").length, 0, "others stay hidden");

  await enable([]);
  assert.equal(modelsOf(await listedModels(), "aihorde").length, 0, "disabling hides them again");
});

test("keyless search endpoints follow the same gate", async () => {
  await enable([]);
  assert.equal(await isNoAuthGateOpenNow("duckduckgo-free"), false);
  assert.equal(await isNoAuthGateOpenNow("context7"), false);
  assert.equal(
    await isNoAuthGateOpenNow("serper-search"),
    true,
    "keyed providers are not gated here"
  );
  assert.equal(
    (await listedModels()).some((m) => m.id === "duckduckgo-free/search"),
    false
  );
  await enable(["duckduckgo-free"]);
  const { activateFixtureModels } = await import("../../helpers/modelActivationFixtures.ts");
  await activateFixtureModels("duckduckgo-free", ["search"]);
  assert.equal(await isNoAuthGateOpenNow("duckduckgo-free"), true);
  assert.equal(
    (await listedModels()).some((m) => m.id === "duckduckgo-free/search"),
    true
  );
});

test("the combo builder offers a no-auth source only once enabled", async () => {
  await enable([]);
  const ids = async () => (await getComboBuilderOptions()).providers.map((p) => p.providerId);
  assert.equal((await ids()).includes("aihorde"), false);
  assert.ok((await ids()).includes("openai"), "connected providers are offered");
  await enable(["aihorde"]);
  assert.ok((await ids()).includes("aihorde"));
});

test("GET /api/providers exposes enabled and kind per provider without dropping fields", async () => {
  await enable(["aihorde"]);
  const body = (await (
    await getProviders(new Request("http://localhost/api/providers"))
  ).json()) as {
    connections: unknown[];
    total: number;
    providerAvailability: Record<string, { enabled: boolean; kind: string }>;
  };
  assert.ok(Array.isArray(body.connections));
  assert.equal(typeof body.total, "number");
  assert.deepEqual(body.providerAvailability.openai, { enabled: true, kind: "connected" });
  assert.deepEqual(body.providerAvailability.aihorde, { enabled: true, kind: "free-optin" });
  assert.deepEqual(body.providerAvailability.uncloseai, { enabled: false, kind: "available" });
  assert.deepEqual(body.providerAvailability.anthropic, { enabled: false, kind: "available" });
  assert.deepEqual(body.providerAvailability["ollama-local"], {
    enabled: false,
    kind: "available",
  });
});

test("PATCH /api/settings stores canonical ids and drops unknown ones", async () => {
  const response = await patchSettings(
    new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabledNoAuthProviders: [ID_TO_ALIAS.opencode, "aihorde", "nope", "openai", "aihorde"],
      }),
    })
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await getSettings()).enabledNoAuthProviders, ["opencode", "aihorde"]);
  assert.equal(ALIAS_TO_ID[ID_TO_ALIAS.opencode], "opencode");

  const invalid = await patchSettings(
    new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabledNoAuthProviders: ["has space"] }),
    })
  );
  assert.equal(invalid.status, 400);
});
