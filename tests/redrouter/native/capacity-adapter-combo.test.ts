import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "redrouter-capacity-adapter-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../../src/lib/db/core.ts");
const { handleComboChat } = await import("../../../open-sse/services/combo.ts");

beforeEach(() => {
  core.resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
});
after(() => {
  core.resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

const log = { info() {}, warn() {}, error() {}, debug() {} };
const IMAGE_BODY = {
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "what is in this picture?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    },
  ],
};

async function run(settings: unknown) {
  const { activateFixtureModels } = await import("../../helpers/modelActivationFixtures.ts");
  await activateFixtureModels("openai", ["gpt-4o"]);
  const dispatched: string[] = [];
  const response = await handleComboChat({
    body: structuredClone(IMAGE_BODY),
    combo: {
      id: "c1",
      name: "text-only",
      strategy: "priority",
      models: ["deepseek/deepseek-chat"],
    },
    handleSingleModel: async (_body: unknown, modelStr: string) => {
      dispatched.push(modelStr);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    isModelAvailable: async () => true,
    log,
    settings,
    relayOptions: null,
    allCombos: null,
  } as never);
  return { response, dispatched };
}

test("without the adapter an image request to a text-only combo fails closed", async () => {
  const { response, dispatched } = await run(null);
  assert.ok(response.status >= 400 && response.status < 500, `got ${response.status}`);
  assert.deepEqual(dispatched, []);
});

test("with a vision pool the image goes to the pool model", async () => {
  const { response, dispatched } = await run({
    capacityAdapter: { vision: { enabled: true, models: ["openai/gpt-4o"] } },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(dispatched, ["openai/gpt-4o"]);
});

test("a disabled pool changes nothing", async () => {
  const { response, dispatched } = await run({
    capacityAdapter: { vision: { enabled: false, models: ["openai/gpt-4o"] } },
  });
  assert.ok(response.status >= 400);
  assert.deepEqual(dispatched, []);
});
