import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

const dir = mkdtempSync(join(tmpdir(), "redrouter-explicit-auto-"));
process.env.DATA_DIR = dir;
process.env.REQUIRE_API_KEY = "false";
process.env.INITIAL_PASSWORD = "";
process.env.API_KEY_SECRET = "explicit-auto-fixture-secret";
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const models = await import("../../../src/lib/db/models.ts");
const providers = await import("../../../src/lib/db/providers.ts");
const combos = await import("../../../src/lib/db/combos.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { getUnifiedModelsResponse } = await import("../../../src/app/api/v1/models/catalog.ts");
const { handleChat } = await import("../../../src/sse/handlers/chat.ts");
const { initTranslators } = await import("../../../open-sse/translator/index.ts");
const { POST: savePreset } = await import("../../../src/app/api/combos/duplicate/route.ts");
const { commitRemoteRouterCatalog } = await import("../../../src/lib/db/remoteRouterCatalog.ts");
const { remoteRouterSnapshot } =
  await import("../../../src/lib/providerModels/remoteRouterCatalog.ts");
const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; model: string }> = [];
let nonce = 0;

after(() => {
  globalThis.fetch = originalFetch;
  resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});

async function catalogIds(): Promise<string[]> {
  const response = await getUnifiedModelsResponse(new Request("http://localhost/v1/models"));
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).data.map((row: { id: string }) => row.id);
}
function chat(model: string) {
  return handleChat(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: "user", content: `ping ${++nonce}` }],
      }),
    })
  );
}
function preset() {
  return makeManagementSessionRequest("http://localhost/api/combos/duplicate", {
    method: "POST",
    body: { name: "auto/best-chat", strategy: "priority" },
  }).then(savePreset);
}

test("connections, activated models and catalog reads never create auto routes; only an explicit preset action saves a combo", async () => {
  initTranslators();
  await updateSettings({
    transparentModels: true,
    hideAutoCombos: false,
    autoRoutingEnabled: true,
  });
  await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "fixture-key",
    isActive: true,
    testStatus: "active",
  });
  await models.addCustomModel("openai", "gpt-6-astra");
  assert.equal((await preset()).status, 422, "unselected models cannot be used by presets");
  assert.deepEqual(await combos.getCombos(), []);
  await models.setModelActivation("openai", "gpt-6-astra", true);
  await models.addCustomModel("openai", "unselected-model");
  const ids = await catalogIds();
  assert.ok(ids.includes("openai/gpt-6-astra"));
  assert.ok(!ids.some((id) => id === "auto" || id.startsWith("auto/")));
  assert.deepEqual(await combos.getCombos(), []);

  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    calls.push({ url: String(input), model: body.model });
    if (new URL(String(input)).pathname.endsWith("/responses")) {
      return Response.json({
        id: "resp-explicit-auto",
        object: "response",
        status: "completed",
        model: body.model,
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }
    return Response.json({
      id: "chatcmpl-explicit-auto",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  };
  for (const id of ["auto", "auto/best-chat", "auto/fast"]) {
    const denied = await chat(id);
    assert.equal(denied.status, 403, await denied.clone().text());
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(await combos.getCombos(), []);

  const saved = await preset();
  assert.equal(saved.status, 201, await saved.clone().text());
  const combo = await saved.json();
  assert.equal((await combos.getCombos()).length, 1);
  assert.equal(models.getModelIsHidden("openai", "unselected-model"), true);
  assert.ok((await catalogIds()).includes(combo.name));
  const response = await chat(combo.name);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(
    calls.map((call) => call.model),
    ["gpt-6-astra"]
  );

  await combos.createCombo({
    name: "auto/fast",
    strategy: "priority",
    isActive: false,
    models: [{ model: "openai/gpt-6-astra", providerId: "openai" }],
  });
  const disabled = await chat("auto/fast");
  assert.equal(disabled.status, 403);
  assert.equal(calls.length, 1);
  assert.ok(!(await catalogIds()).includes("auto/fast"));
});

test("remote auto models require local opt-in and forward their native IDs without invoking local auto routing", async () => {
  const connection = await providers.createProviderConnection({
    provider: "red-router",
    authType: "apikey",
    apiKey: "remote-fixture-key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl: "https://remote.example/v1", autoFetchModels: false },
  });
  const snapshot = remoteRouterSnapshot(connection);
  assert.equal(
    commitRemoteRouterCatalog(snapshot, {
      fingerprint: snapshot.fingerprint,
      syncedAt: Date.now(),
      models: [{ id: "auto" }, { id: "auto/best-chat" }],
    }),
    true
  );
  assert.equal(models.getModelIsHidden("red-router", "auto"), true);
  assert.ok(!(await catalogIds()).some((id) => id.startsWith("red/auto")));
  calls.length = 0;
  const denied = await chat("red/auto");
  assert.equal(denied.status, 403, await denied.clone().text());
  assert.deepEqual(calls, []);

  await models.setModelActivation("red-router", "auto", true);
  assert.ok((await catalogIds()).includes("red/auto"));
  assert.ok(!(await catalogIds()).includes("red/auto/best-chat"));
  const response = await chat("red/auto");
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(calls, [{ url: "https://remote.example/v1/chat/completions", model: "auto" }]);
  await models.setModelActivation("red-router", "auto", false);
  const revoked = await chat("red/auto");
  assert.equal(revoked.status, 403);
  assert.equal(calls.length, 1);
});
