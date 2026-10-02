import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

const dir = mkdtempSync(join(tmpdir(), "redrouter-clear-models-"));
process.env.DATA_DIR = dir;
process.env.API_KEY_SECRET = "clear-models-fixture-secret";
process.env.INITIAL_PASSWORD = "";
const core = await import("../../../src/lib/db/core.ts");
const models = await import("../../../src/lib/db/models.ts");
const providers = await import("../../../src/lib/db/providers.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const remote = await import("../../../src/lib/db/remoteRouterCatalog.ts");
const { remoteRouterSnapshot } =
  await import("../../../src/lib/providerModels/remoteRouterCatalog.ts");
const route = await import("../../../src/app/api/provider-models/route.ts");
const { GET: syncedCatalog } =
  await import("../../../src/app/api/synced-available-models/route.ts");

after(() => {
  core.resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});

test("clearing RedRouter removes every connection inventory and remote cache while preserving other providers and credentials", async () => {
  await updateSettings({ requireLogin: true, password: "fixture-password-hash" });
  const snapshots = [];
  for (const name of ["first", "second"]) {
    const connection = await providers.createProviderConnection({
      provider: "red-router",
      authType: "apikey",
      apiKey: `${name}-fixture-key`,
      isActive: true,
      providerSpecificData: { baseUrl: `https://${name}.example/v1`, autoFetchModels: false },
    });
    const snapshot = remoteRouterSnapshot(connection);
    snapshots.push(snapshot);
    assert.equal(
      remote.commitRemoteRouterCatalog(snapshot, {
        fingerprint: snapshot.fingerprint,
        syncedAt: Date.now(),
        models: [{ id: `vendor/${name}-model`, type: "chat" }],
      }),
      true
    );
  }
  await models.addCustomModel("red-router", "custom-model");
  await models.addCustomModel("openrouter", "typesafe/jev-latest");
  await models.replaceSyncedAvailableModelsForConnection("openrouter", "other-connection", [
    { id: "vendor/other-model" },
  ]);

  const url = "http://localhost/api/provider-models?provider=red-router&all=true";
  const denied = await route.DELETE(new Request(url, { method: "DELETE" }));
  assert.equal(denied.status, 401);
  assert.ok(!(await denied.text()).includes("at /"));
  assert.equal((await models.getSyncedAvailableModels("red-router")).length, 2);

  const response = await route.DELETE(
    await makeManagementSessionRequest(url, { method: "DELETE" })
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.cleared, true);
  assert.equal(result.syncedAvailableModelListsRemoved, 2);
  assert.equal(result.remoteCatalogsRemoved, 2);
  assert.deepEqual(await models.getCustomModels("red-router"), []);
  assert.deepEqual(await models.getSyncedAvailableModels("red-router"), []);
  for (const snapshot of snapshots) {
    assert.equal(remote.readRemoteRouterCatalog(snapshot), null);
    const connection = await providers.getProviderConnectionById(snapshot.id);
    assert.equal(remoteRouterSnapshot(connection).fingerprint, snapshot.fingerprint);
    assert.equal(connection.isActive, true);
    assert.equal(connection.providerSpecificData.autoFetchModels, false);
  }
  assert.equal((await models.getCustomModels("openrouter")).length, 1);
  assert.equal((await models.getSyncedAvailableModels("openrouter")).length, 1);
  const catalog = await syncedCatalog(
    await makeManagementSessionRequest(
      "http://localhost/api/synced-available-models?provider=red-router"
    )
  );
  assert.equal(catalog.status, 200);
  assert.deepEqual((await catalog.json()).models, []);
});
