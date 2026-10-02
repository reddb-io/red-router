import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "redrouter-s1-contract-"));
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
const { POST: evaluate } = await import("../../../src/app/api/v1/systemone/route.ts");
const { commitRemoteRouterCatalog } = await import("../../../src/lib/db/remoteRouterCatalog.ts");
const { remoteRouterSnapshot } =
  await import("../../../src/lib/providerModels/remoteRouterCatalog.ts");
const { createTenant, assignResourcesToTenant } = await import("../../../src/lib/db/tenants.ts");
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});
function request(path: string, key: string, body?: Record<string, unknown>) {
  return new Request(`http://localhost/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function discover(key: string) {
  const listed = await catalog(request("models?capabilities=decision", key));
  const advertised = await capabilities(request("capabilities", key));
  assert.equal(listed.status, 200);
  assert.equal(advertised.status, 200);
  const data = (await listed.json()).data as Array<{
    id: string;
    supported_endpoints: string[];
    capabilities: { decision: boolean };
    availability: string;
  }>;
  const document = await advertised.json();
  assert.deepEqual(document.systemone.models.sort(), data.map((row) => row.id).sort());
  assert.equal(document.systemone.endpoint, "/v1/systemone");
  assert.equal(document.systemone.availability, "not_probed");
  assert.equal(document.systemone.available, data.length > 0);
  for (const row of data) {
    assert.equal(row.capabilities.decision, true);
    assert.deepEqual(row.supported_endpoints, ["systemone", "decisions"]);
    assert.equal(row.availability, "not_probed");
  }
  return data.map((row) => row.id).sort();
}

test("S1 discovery agrees across keys, transparency, federation and immediate policy/activation changes; selected credential reaches native upstream", async () => {
  await updateSettings({
    hideAutoCombos: true,
    hidePaidModels: false,
    transparentModels: false,
    requireLogin: false,
  });
  const openrouter = await providers.createProviderConnection({
    provider: "openrouter",
    authType: "apikey",
    apiKey: "openrouter-upstream-fixture",
    isActive: true,
    providerSpecificData: { autoFetchModels: false },
  });
  const remote = await providers.createProviderConnection({
    provider: "red-router",
    authType: "apikey",
    apiKey: "remote-upstream-fixture",
    isActive: true,
    providerSpecificData: { baseUrl: "https://remote.example/v1", autoFetchModels: false },
  });
  const snapshot = remoteRouterSnapshot(remote);
  commitRemoteRouterCatalog(snapshot, {
    fingerprint: snapshot.fingerprint,
    syncedAt: Date.now(),
    models: [
      {
        id: "red/openrouter/typesafe/jev-1.13",
        capabilities: { decision: true },
        supported_endpoints: ["/v1/decisions"],
      },
    ],
  });
  await models.setModelActivation("openrouter", "typesafe/jev-1.13", true);
  await models.setModelActivation("red-router", "red/openrouter/typesafe/jev-1.13", true);
  const direct = await keys.createApiKey("Direct", "tests", [], {
    allowedConnections: [String(openrouter.id)],
    allowedModels: ["openrouter/typesafe/jev-1.13"],
    modelAccessMode: "restricted",
  });
  const federated = await keys.createApiKey("Federated", "tests", [], {
    allowedConnections: [String(remote.id)],
    allowedModels: ["red/red/openrouter/typesafe/jev-1.13"],
    modelAccessMode: "restricted",
  });
  assert.deepEqual(await discover(direct.key), ["openrouter/typesafe/jev-1.13"]);
  assert.deepEqual(await discover(federated.key), ["red/red/openrouter/typesafe/jev-1.13"]);
  assert.deepEqual(
    await discover(direct.key),
    ["openrouter/typesafe/jev-1.13"],
    "a cached remote-key projection never leaks across keys"
  );

  let sends = 0;
  const body = {
    model: "openrouter/typesafe/jev-1.13",
    state: { text: "Ready" },
    questions: { ready: { type: "noul", instructions: "Is this ready?" } },
    extension: { keep: true },
  };
  globalThis.fetch = async (url, init) => {
    sends++;
    assert.equal(String(url), "https://openrouter.ai/api/v1/systemone");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer openrouter-upstream-fixture"
    );
    assert.deepEqual(JSON.parse(String(init?.body)), { ...body, model: "typesafe/jev-1.13" });
    return Response.json({ answers: { ready: { type: "noul", noul: 0.99 } } });
  };
  const response = await evaluate(request("systemone", direct.key, body));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).answers.ready.noul, 0.99);
  assert.equal(sends, 1);
  globalThis.fetch = originalFetch;

  await keys.updateApiKeyPermissions(direct.id, { allowedEndpoints: ["chat"] });
  assert.deepEqual(
    await discover(direct.key),
    [],
    "a key denied the decisions endpoint cannot discover S1 models"
  );
  await keys.updateApiKeyPermissions(direct.id, { allowedEndpoints: ["decisions"] });
  assert.deepEqual(await discover(direct.key), ["openrouter/typesafe/jev-1.13"]);
  await keys.updateApiKeyPermissions(direct.id, { allowedEndpoints: [] });
  await keys.updateApiKeyPermissions(direct.id, {
    blockedModels: ["openrouter/typesafe/jev-1.13"],
  });
  assert.deepEqual(await discover(direct.key), []);
  await keys.updateApiKeyPermissions(direct.id, { blockedModels: [] });
  assert.deepEqual(await discover(direct.key), ["openrouter/typesafe/jev-1.13"]);
  await models.setModelActivation("openrouter", "typesafe/jev-1.13", false);
  assert.deepEqual(await discover(direct.key), []);
  await models.setModelActivation("openrouter", "typesafe/jev-1.13", true);
  await providers.updateProviderConnection(String(openrouter.id), { isActive: false });
  assert.deepEqual(await discover(direct.key), []);
  await providers.updateProviderConnection(String(openrouter.id), { isActive: true });
  assert.deepEqual(await discover(direct.key), ["openrouter/typesafe/jev-1.13"]);
  const tenant = createTenant({ name: "Other", slug: "s1-other" });
  assignResourcesToTenant(tenant.id, { connectionIds: [String(openrouter.id)] });
  assert.deepEqual(
    await discover(direct.key),
    [],
    "tenant movement invalidates discovery without waiting for a cache TTL"
  );
  assert.deepEqual(await discover(federated.key), ["red/red/openrouter/typesafe/jev-1.13"]);
});
