import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "redrouter-selection-route-"));
process.env.DATA_DIR = dir;
process.env.INITIAL_PASSWORD = "";
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { createProviderConnection } = await import("../../../src/lib/db/providers.ts");
const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { commitRemoteRouterCatalog } = await import("../../../src/lib/db/remoteRouterCatalog.ts");
const { remoteRouterSnapshot } =
  await import("../../../src/lib/providerModels/remoteRouterCatalog.ts");
const { GET: models } = await import("../../../src/app/api/providers/[id]/models/route.ts");
const { POST: validate } = await import("../../../src/app/api/setup/validate/route.ts");
let remoteId: string;
let openrouterId: string;
let client: Awaited<ReturnType<typeof createApiKey>>;
let manage: Awaited<ReturnType<typeof createApiKey>>;
before(async () => {
  await updateSettings({ requireLogin: false });
  manage = await createApiKey("Manager", "tests", ["manage"]);
  const connection = await createProviderConnection({
    provider: "red-router",
    name: "Remote",
    authType: "apikey",
    apiKey: "upstream-secret",
    isActive: true,
    providerSpecificData: { baseUrl: "https://remote.example/v1", autoFetchModels: false },
  });
  remoteId = String(connection.id);
  const snapshot = remoteRouterSnapshot(connection);
  assert.equal(
    commitRemoteRouterCatalog(snapshot, {
      fingerprint: snapshot.fingerprint,
      syncedAt: Date.now(),
      models: [
        { id: "openrouter/chat", type: "chat", capabilities: { reasoning: true } },
        { id: "red/openrouter/typesafe/jev-1.13", capabilities: { decision: true } },
      ],
    }),
    true
  );
  openrouterId = String(
    (
      await createProviderConnection({
        provider: "openrouter",
        authType: "apikey",
        apiKey: "fake-key",
        isActive: true,
      })
    ).id
  );
  client = await createApiKey("Client", "tests", [], {
    allowedConnections: [remoteId],
    allowedModels: ["red/openrouter/chat"],
    modelAccessMode: "restricted",
  });
});
after(() => {
  resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});

function request(path: string, body?: Record<string, unknown>) {
  return new Request(`http://localhost${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${manage.key}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
test("OpenRouter S1 models are available without a chat catalog or credential probe", async () => {
  const response = await models(
    request(`/api/providers/${openrouterId}/models?capabilities=decision`),
    { params: { id: openrouterId } }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source, "decision_registry");
  assert.deepEqual(
    body.models.map((row: { fullModel: string }) => row.fullModel),
    ["openrouter/typesafe/jev-1.13"]
  );
});
test("remote decision selection preserves every hop and chat filtering excludes S1", async () => {
  for (const [role, expected] of [
    ["decision", "red/red/openrouter/typesafe/jev-1.13"],
    ["chat", "red/openrouter/chat"],
  ]) {
    const response = await models(
      request(`/api/providers/${remoteId}/models?capabilities=${role}`),
      { params: { id: remoteId } }
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      body.models.map((row: { fullModel: string }) => row.fullModel),
      [expected]
    );
  }
});
test("Setup validates the chosen key's effective connection/model scope through the actual route", async () => {
  const selection = {
    connectionId: remoteId,
    model: "red/openrouter/chat",
    apiKeyId: client.id,
    apiKey: client.key,
  };
  const good = await validate(request("/api/setup/validate", selection));
  assert.equal(good.status, 200);
  assert.equal((await good.json()).status, "ready");
  for (const changed of [
    { apiKeyId: manage.id },
    { connectionId: openrouterId },
    { model: "red/openrouter/other" },
  ]) {
    const response = await validate(request("/api/setup/validate", { ...selection, ...changed }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "action_required");
  }
});
test("malformed input and unknown accounts return sanitized errors", async () => {
  const malformed = await validate(request("/api/setup/validate", { connectionId: remoteId }));
  assert.equal(malformed.status, 400);
  const missing = await models(request("/api/providers/missing/models?capabilities=decision"), {
    params: { id: "missing" },
  });
  assert.equal(missing.status, 404);
  for (const response of [malformed, missing]) {
    const body = await response.json();
    assert.equal(body.error.message.includes("at /"), false);
    assert.equal(JSON.stringify(body).includes("upstream-secret"), false);
  }
});
