import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "redrouter-compatible-probe-"));
process.env.DATA_DIR = dir;
process.env.API_KEY_SECRET = "compatible-probe-fixture-secret";
const core = await import("../../../src/lib/db/core.ts");
const providers = await import("../../../src/lib/db/providers.ts");
const models = await import("../../../src/lib/db/models.ts");
const settings = await import("../../../src/lib/db/settings.ts");
const { runSingleModelTest } = await import("../../../src/lib/api/modelTestRunner.ts");
const originalFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = originalFetch;
  await core.shutdownDbInstance();
  rmSync(dir, { recursive: true, force: true });
});

test("compatible model tests preserve native namespaces and return a bounded timeout without poisoning the connection", async () => {
  await settings.updateSettings({ requireLogin: false, probeCanDisable: false });
  const node = await providers.createProviderNode({
    // Match the identity assigned by the provider-node creation API.
    id: "openai-compatible-chat-probe",
    name: "Probe gateway",
    type: "openai-compatible",
    apiType: "chat",
    prefix: "probe",
    baseUrl: "https://compatible.example/v1",
  });
  const providerId = String(node.id);
  const connection = await providers.createProviderConnection({
    provider: providerId,
    authType: "apikey",
    apiKey: "fixture-key",
    isActive: true,
    testStatus: "active",
    // POST /api/providers persists the selected node's dispatch settings.
    providerSpecificData: {
      baseUrl: node.baseUrl,
      apiType: node.apiType,
      prefix: node.prefix,
    },
  });
  await models.replaceSyncedAvailableModelsForConnection(providerId, String(connection.id), [
    {
      id: "vendor/glm-5.3-flash",
      nativeModelId: "vendor/glm-5.3-flash",
      supportedEndpoints: ["chat"],
    },
  ]);
  const calls: { url: string; model: string }[] = [];
  let hang = false;
  let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), model: JSON.parse(String(init?.body)).model });
    if (!hang)
      return Response.json({ choices: [{ message: { role: "assistant", content: "pong" } }] });
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          upstream = controller;
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    );
  };
  const options = {
    providerId,
    modelId: "probe/vendor/glm-5.3-flash",
    connectionId: String(connection.id),
    timeoutMs: 1000,
  };
  try {
    const successful = await runSingleModelTest({ ...options, timeoutMs: 10_000 });
    assert.equal(successful.status, "ok", JSON.stringify(successful));
    assert.ok(
      calls.some(
        (call) =>
          call.url === "https://compatible.example/v1/chat/completions" &&
          call.model === "vendor/glm-5.3-flash"
      ),
      JSON.stringify(calls)
    );
    hang = true;
    const timedOut = await runSingleModelTest(options);
    assert.equal(timedOut.httpStatus, 504);
    assert.equal(timedOut.isTimeout, true);
    assert.equal(timedOut.status, "slow");
    assert.ok(
      timedOut.latencyMs < 5000,
      "a non-closing upstream must respect the diagnostic deadline"
    );
    const saved = await providers.getProviderConnectionById(String(connection.id));
    assert.equal(saved.isActive, true);
    assert.equal(saved.testStatus, "active");
    assert.ok(saved.rateLimitedUntil == null);
  } finally {
    try {
      upstream?.close();
    } catch {
      /* The upstream may already have been canceled. */
    }
    globalThis.fetch = originalFetch;
  }
});
