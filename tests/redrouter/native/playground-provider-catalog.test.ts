import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

const dir = mkdtempSync(join(tmpdir(), "redrouter-playground-catalog-"));
process.env.DATA_DIR = dir;
process.env.JWT_SECRET = "playground-catalog-test-secret";
process.env.API_KEY_SECRET = "playground-catalog-api-test-secret";
const core = await import("../../../src/lib/db/core.ts");
const providers = await import("../../../src/lib/db/providers.ts");
const models = await import("../../../src/lib/db/models.ts");
const settings = await import("../../../src/lib/db/settings.ts");
const { GET: playgroundCatalog } = await import("../../../src/app/api/playground/models/route.ts");
const { getUnifiedModelsResponse } = await import("../../../src/app/api/v1/models/catalog.ts");

const nodeId = "openai-compatible-chat-playground-karavela";
const originalFetch = globalThis.fetch;
let connectionId: string;

after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});

async function ids(response: Response): Promise<string[]> {
  assert.equal(response.status, 200);
  return ((await response.json()) as { data: Array<{ id: string }> }).data.map((row) => row.id);
}

test("the playground catalog requires management authentication", async () => {
  await settings.updateSettings({ requireLogin: true, password: "configured-test-password" });
  const response = await playgroundCatalog(new Request("http://localhost/api/playground/models"));
  assert.ok(response.status === 401 || response.status === 403);
  assert.ok(!(await response.text()).includes("at /"));
});

test("provider selection keeps qualified IDs while the public catalog hides prefixes", async () => {
  await settings.updateSettings({ transparentModels: false, hideAutoCombos: true });
  await providers.createProviderNode({
    id: nodeId,
    type: "openai-compatible",
    name: "Karavela",
    prefix: "karavela",
    apiType: "chat",
    baseUrl: "https://karavela.example/v1",
  });
  const connection = await providers.createProviderConnection({
    provider: nodeId,
    authType: "apikey",
    apiKey: "fixture-key",
    isActive: true,
    providerSpecificData: { baseUrl: "https://karavela.example/v1", apiType: "chat" },
  });
  connectionId = String(connection.id);
  await models.addCustomModel(nodeId, "glm-5.3-flash");
  await models.addCustomModel(nodeId, "mimo-v2.6-pro");
  models.setModelIsHidden(nodeId, "glm-5.3-flash", false);
  const request = () => makeManagementSessionRequest("http://localhost/api/playground/models");
  const dashboardIds = await ids(await playgroundCatalog(await request()));
  assert.ok(dashboardIds.includes("karavela/glm-5.3-flash"));
  assert.ok(!dashboardIds.includes("karavela/mimo-v2.6-pro"), "unselected models stay off");
  const publicIds = await ids(
    await getUnifiedModelsResponse(await makeManagementSessionRequest("http://localhost/v1/models"))
  );
  assert.ok(publicIds.includes("glm-5.3-flash"));
  assert.ok(!publicIds.includes("karavela/glm-5.3-flash"), "dashboard cache cannot leak prefixes");
  assert.deepEqual(await ids(await playgroundCatalog(await request())), dashboardIds);
});

test("a Karavela model probe sends only the upstream ID to its own connection", async () => {
  const calls: Array<{ url: string; model: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    calls.push({ url: String(input), model: body.model });
    return Response.json({
      id: "chatcmpl-fixture",
      choices: [{ message: { role: "assistant", content: "OK" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  };
  try {
    const { runSingleModelTest } = await import("../../../src/lib/api/modelTestRunner.ts");
    const result = await runSingleModelTest({
      providerId: nodeId,
      connectionId,
      modelId: "karavela/glm-5.3-flash",
      streamChat: false,
    });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.deepEqual(calls, [
      { url: "https://karavela.example/v1/chat/completions", model: "glm-5.3-flash" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
