import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const taskDir = mkdtempSync(join(tmpdir(), "redrouter-remote-catalog-"));
process.env.DATA_DIR = taskDir;
const { resetDbInstance, getDbInstance } = await import("../../../src/lib/db/core.ts");
const { createProviderConnection, updateProviderConnection, getProviderConnectionById } =
  await import("../../../src/lib/db/providers.ts");
const { getSyncedAvailableModelsForConnection, getCustomModels } =
  await import("../../../src/lib/db/models.ts");
const { commitRemoteRouterCatalog, readRemoteRouterCatalog } =
  await import("../../../src/lib/db/remoteRouterCatalog.ts");
const { remoteRouterSnapshot } =
  await import("../../../src/lib/providerModels/remoteRouterCatalog.ts");

after(() => {
  resetDbInstance();
  rmSync(taskDir, { recursive: true, force: true });
});

test("remote catalogs persist per credential, survive reopen, and never become global aliases", async () => {
  const a = await createProviderConnection({
    provider: "red-router",
    authType: "apikey",
    name: "Remote A",
    apiKey: "test-remote-a",
    providerSpecificData: { baseUrl: "https://a.example/v1" },
    isActive: true,
  });
  const b = await createProviderConnection({
    provider: "red-router",
    authType: "apikey",
    name: "Remote B",
    apiKey: "test-remote-b",
    providerSpecificData: { baseUrl: "https://b.example/v1" },
    isActive: true,
  });
  const snapshot = remoteRouterSnapshot(a);
  const cache = {
    fingerprint: snapshot.fingerprint,
    syncedAt: Date.now(),
    models: [{ id: "cc/claude-example", context_length: 100000, capabilities: { tools: true } }],
  };
  assert.equal(commitRemoteRouterCatalog(snapshot, cache), true);
  resetDbInstance();
  assert.equal(readRemoteRouterCatalog(snapshot)?.models[0].id, "cc/claude-example");
  const models = await getSyncedAvailableModelsForConnection("red-router", snapshot.id);
  assert.equal(models[0].inputTokenLimit, 100000);
  assert.equal(models[0].supportsTools, true);
  assert.deepEqual(await getSyncedAvailableModelsForConnection("red-router", String(b.id)), []);
  assert.deepEqual(await getCustomModels("red-router"), []);

  await updateProviderConnection(snapshot.id, { apiKey: "test-remote-rotated" });
  assert.equal(readRemoteRouterCatalog(snapshot), null);
  assert.deepEqual(await getSyncedAvailableModelsForConnection("red-router", snapshot.id), []);
  assert.equal(
    commitRemoteRouterCatalog(snapshot, cache),
    false,
    "late old-key fetch must not restore catalog"
  );
  const next = remoteRouterSnapshot(await getProviderConnectionById(snapshot.id));
  assert.notEqual(next.fingerprint, snapshot.fingerprint);
  assert.equal(commitRemoteRouterCatalog(next, { ...cache, fingerprint: next.fingerprint }), true);
  assert.equal(
    commitRemoteRouterCatalog(next, {
      fingerprint: next.fingerprint,
      syncedAt: Date.now(),
      models: [],
    }),
    true
  );
  assert.deepEqual(await getSyncedAvailableModelsForConnection("red-router", snapshot.id), []);
  getDbInstance().prepare("DELETE FROM provider_connections WHERE id = ?").run(snapshot.id);
  assert.equal(commitRemoteRouterCatalog(next, { ...cache, fingerprint: next.fingerprint }), false);
});
