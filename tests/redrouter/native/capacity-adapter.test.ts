import assert from "node:assert/strict";
import test from "node:test";

const adapter = await import("../../../open-sse/services/capacityAdapter.ts");
const { getResolvedModelCapabilities } = await import(
  "../../../open-sse/services/modelCapabilities.ts"
);

const IMAGE_BODY = {
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    },
  ],
};
const TEXT_BODY = { messages: [{ role: "user", content: "hello" }] };

// Pick a vision model and a text-only model the catalog knows, so the test states its assumptions.
const VISION_MODEL = "openai/gpt-4o";
const TEXT_MODEL = "deepseek/deepseek-chat";
const supportsVision = (id: string) => {
  const [provider, ...rest] = id.split("/");
  return getResolvedModelCapabilities({ provider, model: rest.join("/") }).supportsVision;
};

test("the catalog facts this test relies on hold", () => {
  assert.equal(supportsVision(VISION_MODEL), true);
  assert.notEqual(supportsVision(TEXT_MODEL), true);
});

test("a request with an image needs vision, plain text needs nothing", () => {
  assert.deepEqual(adapter.requiredModalities(IMAGE_BODY), ["vision"]);
  assert.deepEqual(adapter.requiredModalities(TEXT_BODY), []);
});

const settings = (over: Record<string, unknown> = {}) => ({
  capacityAdapter: { vision: { enabled: true, models: [VISION_MODEL] }, ...over },
});

test("the pool goes in front when no member can take the image", () => {
  assert.deepEqual(
    adapter.capacityAdapterModels([TEXT_MODEL], ["vision"], settings()),
    [VISION_MODEL]
  );
});

test("a combo that already has a capable member is left alone", () => {
  assert.deepEqual(
    adapter.capacityAdapterModels([TEXT_MODEL, VISION_MODEL], ["vision"], settings()),
    []
  );
});

test("nothing happens while the adapter is off, empty, or the request is text", () => {
  assert.deepEqual(adapter.capacityAdapterModels([TEXT_MODEL], ["vision"], {}), []);
  assert.deepEqual(
    adapter.capacityAdapterModels([TEXT_MODEL], ["vision"], {
      capacityAdapter: { vision: { enabled: false, models: [VISION_MODEL] } },
    }),
    []
  );
  assert.deepEqual(
    adapter.capacityAdapterModels([TEXT_MODEL], ["vision"], {
      capacityAdapter: { vision: { enabled: true, models: [] } },
    }),
    [],
    "there is no built-in default pool member"
  );
  assert.deepEqual(adapter.capacityAdapterModels([TEXT_MODEL], [], settings()), []);
});

test("pool models that cannot take the media are not injected, and a pool for another modality is ignored", () => {
  assert.deepEqual(
    adapter.capacityAdapterModels([TEXT_MODEL], ["vision"], {
      capacityAdapter: { vision: { enabled: true, models: [TEXT_MODEL, "deepseek/deepseek-reasoner"] } },
    }),
    []
  );
  assert.deepEqual(
    adapter.capacityAdapterModels([TEXT_MODEL], ["vision"], {
      capacityAdapter: { audio: { enabled: true, models: [VISION_MODEL] } },
    }),
    [],
    "an audio pool never serves an image request"
  );
});

test("the combo is rebuilt with the pool in front, once, and never mutated", () => {
  const combo = { name: "text-only", models: [{ model: TEXT_MODEL, kind: "model" }] };
  const before = JSON.stringify(combo);
  const result = adapter.applyCapacityAdapterToCombo(combo, IMAGE_BODY, settings());
  assert.deepEqual(result.added, [VISION_MODEL]);
  assert.equal(result.combo.models[0], VISION_MODEL);
  assert.equal(result.combo.models.length, 2);
  assert.equal(JSON.stringify(combo), before);

  const untouched = adapter.applyCapacityAdapterToCombo(combo, TEXT_BODY, settings());
  assert.equal(untouched.combo, combo);
  assert.deepEqual(untouched.added, []);
});

test("the legacy array form of a pool still works", () => {
  assert.deepEqual(
    adapter.capacityAdapterModels([TEXT_MODEL], ["vision"], {
      capacityAdapter: { vision: [{ model: VISION_MODEL, enabled: true }] },
    }),
    [VISION_MODEL]
  );
});
