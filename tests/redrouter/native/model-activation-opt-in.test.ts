import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

const dir = mkdtempSync(join(tmpdir(), "redrouter-model-opt-in-"));
process.env.DATA_DIR = dir;
process.env.REQUIRE_API_KEY = "false";
process.env.INITIAL_PASSWORD = "";
const core = await import("../../../src/lib/db/core.ts");
const models = await import("../../../src/lib/db/models.ts");
const providers = await import("../../../src/lib/db/providers.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { getProviderCredentials } = await import("../../../src/sse/services/auth.ts");
const { getInferenceActivationRejection } =
  await import("../../../src/lib/providers/inferenceActivation.ts");
const { GET: catalog } = await import("../../../src/app/api/v1/models/route.ts");
const { PATCH: selectModels } = await import("../../../src/app/api/provider-models/route.ts");
const { isComboModelVisible } = await import("../../../open-sse/services/combo/comboVisibility.ts");
const { prepareVirtualAutoComboInputs } =
  await import("../../../open-sse/services/autoCombo/virtualFactory.ts");
const { isHiddenForModality } = await import("../../../src/shared/utils/modelVisibility.ts");
const { getModelsByProviderId } = await import("../../../src/shared/constants/models.ts");

after(() => {
  core.resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});

async function listedIds(): Promise<string[]> {
  const response = await catalog(new Request("http://localhost/v1/models"));
  assert.equal(response.status, 200);
  return ((await response.json()) as { data: Array<{ id: string }> }).data.map((entry) => entry.id);
}

async function select(provider: string, ids: string[], hidden = false) {
  const response = await selectModels(
    await makeManagementSessionRequest(
      `http://localhost/api/provider-models?provider=${provider}`,
      { method: "PATCH", body: { modelIds: ids, isActive: !hidden } }
    )
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).updated, ids.length);
}

test("discovery, free pricing and a connected provider never implicitly activate models", async () => {
  await updateSettings({ hideAutoCombos: true, hidePaidModels: false });
  const connection = await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "test-key",
    name: "Opt-in connection",
  });
  assert.equal(connection.isActive, false, "new connections default off");
  const modelId = "rr-free-test";
  await models.addCustomModel("openai", modelId);
  await models.updateCustomModel("openai", modelId, { isFree: true });
  assert.equal(models.getModelIsHidden("openai", modelId), true);
  assert.equal(isHiddenForModality({}), true);
  assert.equal((await getInferenceActivationRejection("openai", modelId, "chat"))?.status, 403);
  assert.deepEqual(await listedIds(), []);

  await providers.updateProviderConnection(String(connection.id), { isActive: true });
  assert.equal(await getProviderCredentials("openai", null, null, modelId), null);
  assert.deepEqual(
    await listedIds(),
    [],
    "enabling the connection does not activate its inventory"
  );
  assert.equal(isComboModelVisible(`openai/${modelId}`), false);

  await select("openai", [modelId]);
  assert.equal(models.getModelIsHidden("openai", modelId), false);
  assert.ok(await getProviderCredentials("openai", null, null, modelId));
  assert.equal(await getInferenceActivationRejection("openai", modelId, "chat"), null);
  assert.ok((await listedIds()).includes(`openai/${modelId}`));
  assert.equal(isComboModelVisible(`openai/${modelId}`), true);

  await providers.updateProviderConnection(String(connection.id), { isActive: false });
  assert.equal(
    await getProviderCredentials("openai", null, null, modelId, {
      forcedConnectionId: String(connection.id),
    }),
    null,
    "pinning an inactive connection cannot recover or enable it"
  );
  assert.equal((await providers.getProviderConnectionById(String(connection.id))).isActive, false);
  assert.deepEqual(await listedIds(), []);
});

test("sync preserves selections while new discoveries stay off; bulk selection spans pages", async () => {
  const connection = await providers.createProviderConnection({
    provider: "openrouter",
    authType: "apikey",
    apiKey: "test-key",
    isActive: true,
  });
  const inventory = Array.from({ length: 205 }, (_, index) => ({ id: `vendor/model-${index}` }));
  await models.replaceSyncedAvailableModelsForConnection(
    "openrouter",
    String(connection.id),
    inventory
  );
  assert.equal(
    (await models.getSyncedAvailableModelsForConnection("openrouter", String(connection.id)))
      .length,
    205
  );
  for (const model of inventory)
    assert.equal(models.getModelIsHidden("openrouter", model.id), true);
  assert.equal(
    (await prepareVirtualAutoComboInputs({ includeResolvedCapabilities: false })).regularCandidates
      .length,
    0
  );

  await select("openrouter", [inventory[0].id, inventory[204].id]);
  let active = (await listedIds()).filter((id) => id.startsWith("openrouter/"));
  assert.deepEqual(active.sort(), [0, 204].map((i) => `openrouter/${inventory[i].id}`).sort());
  const addedId = "vendor/new-free-model";
  await models.replaceSyncedAvailableModelsForConnection("openrouter", String(connection.id), [
    ...inventory,
    { id: addedId, isFree: true },
  ]);
  assert.equal(models.getModelIsHidden("openrouter", inventory[204].id), false);
  assert.equal(models.getModelIsHidden("openrouter", addedId), true);

  await select(
    "openrouter",
    inventory.map((entry) => entry.id)
  );
  active = (await listedIds()).filter((id) => id.startsWith("openrouter/"));
  assert.equal(active.length, 205);
  assert.equal(
    (await prepareVirtualAutoComboInputs({ includeResolvedCapabilities: false })).regularCandidates
      .length,
    205
  );
  await select(
    "openrouter",
    inventory.map((entry) => entry.id),
    true
  );
  assert.equal(
    (await prepareVirtualAutoComboInputs({ includeResolvedCapabilities: false })).regularCandidates
      .length,
    0
  );
});

test("enabling a keyless free provider still requires selecting a model", async () => {
  await updateSettings({ enabledNoAuthProviders: ["uncloseai"] });
  const modelId = getModelsByProviderId("uncloseai")[0]?.id;
  assert.ok(modelId, "the provider has a discoverable inventory");
  assert.equal(await getProviderCredentials("uncloseai", null, null, modelId), null);
  await select("uncloseai", [modelId]);
  assert.ok(await getProviderCredentials("uncloseai", null, null, modelId));
  await select("uncloseai", [modelId], true);
  assert.equal(await getProviderCredentials("uncloseai", null, null, modelId), null);
});

test("decisions, scoped selections and effort aliases obey the same explicit opt-in", async () => {
  models.setModelIsHidden("openrouter", "typesafe/jev-1.13", false, "systemone");
  assert.equal(models.getModelIsHidden("openrouter", "typesafe/jev-1.13", "systemone"), false);
  assert.equal(models.getModelIsHidden("openrouter", "typesafe/jev-1.13", "chat"), true);
  models.setModelIsHidden("cx", "gpt-6-astra", false);
  assert.equal(models.getModelIsHidden("codex", "gpt-6-astra-ultra"), false);
  models.setModelIsHidden("codex", "gpt-6-astra-ultra", true);
  assert.equal(models.getModelIsHidden("cx", "gpt-6-astra-ultra"), true);
  models.setModelIsHidden("cx", "gpt-6-astra", true);
  await models.setModelActivation("codex", "gpt-6-astra", true);
  assert.equal(
    models.getModelIsHidden("codex", "gpt-6-astra"),
    false,
    "the latest activation reconciles decisions stored under provider aliases"
  );
  models.setModelIsHidden("openrouter", "typesafe/jev-1.13", true, "chat");
  await models.setModelActivation("openrouter", "typesafe/jev-1.13", true);
  assert.equal(models.getModelIsHidden("openrouter", "typesafe/jev-1.13", "chat"), false);
  assert.equal(models.getModelIsHidden("openrouter", "typesafe/jev-1.13", "systemone"), false);
  models.setModelIsHidden("cursor", "claude-fable-5", false);
  assert.equal(
    models.getModelIsHidden("cursor", "claude-fable-5-high"),
    true,
    "native upstream IDs require their own selection"
  );
});
