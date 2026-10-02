import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mapProviderId,
  transformModelsDevToCapabilities,
  transformModelsDevToPricing,
  type ModelsDevData,
  type ModelsDevModel,
} from "../../../src/lib/modelsDevSync/transform.ts";

function offering(id: string, input: number): ModelsDevData[string] {
  return {
    id,
    models: { native: { id: "native", name: "Native", cost: { input, output: input * 2 } } },
  };
}

test("commercial products and regions stay separate regardless of source ordering", () => {
  const raw: ModelsDevData = {
    zai: offering("zai", 0.15),
    "zai-coding-plan": offering("zai-coding-plan", 0),
    minimax: offering("minimax", 1),
    "minimax-cn": offering("minimax-cn", 2),
    moonshotai: offering("moonshotai", 3),
    "moonshotai-cn": offering("moonshotai-cn", 4),
    google: offering("google", 5),
    "google-vertex": offering("google-vertex", 6),
    "google-vertex-anthropic": offering("google-vertex-anthropic", 9),
    opencode: offering("opencode", 7),
    "opencode-go": offering("opencode-go", 8),
  };
  const reversed = Object.fromEntries(Object.entries(raw).reverse());
  const prices = transformModelsDevToPricing(raw);
  assert.deepEqual(prices, transformModelsDevToPricing(reversed));
  assert.deepEqual(
    transformModelsDevToCapabilities(raw),
    transformModelsDevToCapabilities(reversed)
  );
  assert.equal(prices.zai.native.input, 0.15);
  assert.equal(prices.glm.native.input, 0);
  assert.equal(prices.glmt.native.input, 0);
  assert.equal(prices.minimax.native.input, 1);
  assert.equal(prices["minimax-cn"].native.input, 2);
  assert.equal(prices.kimi.native.input, 3);
  assert.equal(prices["moonshotai-cn"].native.input, 4);
  assert.equal(prices.gemini.native.input, 5);
  assert.equal(prices.vertex.native.input, 6);
  assert.equal(prices["vertex-partner"].native.input, 9);
  assert.equal(prices.vp.native.input, 9);
  assert.equal(prices["opencode-zen"].native.input, 7);
  assert.equal(prices["opencode-go"].native.input, 8);
});

test("vendor metadata does not claim subscription transports or unrelated gateways", () => {
  const prices = transformModelsDevToPricing({
    openai: offering("openai", 1),
    anthropic: offering("anthropic", 2),
    bedrock: offering("bedrock", 3),
    deepseek: offering("deepseek", 4),
    togetherai: offering("togetherai", 5),
    github: offering("github", 6),
    "github-copilot": offering("github-copilot", 7),
  });
  for (const unrelated of [
    "cx",
    "codex",
    "cc",
    "claude",
    "kiro",
    "kr",
    "qoder",
    "if",
    "openrouter",
  ])
    assert.equal(prices[unrelated], undefined);
  assert.equal(prices["github-models"].native.input, 6);
  assert.equal(prices.github.native.input, 7);
  assert.equal(prices.gh.native.input, 7);
  assert.deepEqual(mapProviderId("huggingface"), ["huggingface", "hf"]);
});

test("ambiguous aliases reject a candidate instead of choosing the download order", () => {
  const raw = {
    togetherai: offering("togetherai", 1),
    together_ai: offering("together_ai", 2),
  };
  assert.throws(() => transformModelsDevToPricing(raw), /mapping collision/);
  assert.throws(() => transformModelsDevToCapabilities(raw), /mapping collision/);
});

test("native IDs, decision type, canonical identity and native reasoning options are independent", () => {
  const model: ModelsDevModel = {
    id: "~typesafe/jev-latest",
    name: "JEV",
    canonical_model_id: "typesafe/jev-latest",
    type: "decision",
    reasoning: false,
    tool_call: false,
    reasoning_options: [
      { type: "toggle" },
      { type: "effort", values: [null, "low", "medium", "high", "max"] },
      { type: "budget_tokens", min: -1, max: 32768 },
    ],
    cost: { input: 0.042, output: 0, input_audio: 1, output_audio: 2 },
  };
  const raw = { openrouter: { id: "openrouter", models: { "catalog-key": model } } };
  const caps = transformModelsDevToCapabilities(raw).openrouter;
  assert.equal(caps["catalog-key"], undefined);
  assert.equal(caps["typesafe/jev-latest"], undefined);
  const cap = caps["~typesafe/jev-latest"];
  assert.equal(cap.model_type, "decision");
  assert.equal(cap.canonical_model_id, "typesafe/jev-latest");
  assert.equal(cap.source_provider, "openrouter");
  assert.equal(cap.native_model_id, model.id);
  assert.equal(cap.metadata_source, "models-dev");
  assert.equal(cap.reasoning, false);
  assert.deepEqual(JSON.parse(cap.reasoning_options!), model.reasoning_options);
  const pricing = transformModelsDevToPricing(raw).openrouter[model.id];
  assert.equal(pricing.input_audio, 1);
  assert.equal(pricing.output_audio, 2);
});

test("output image/video modalities do not imply vision input", () => {
  const models: Record<string, ModelsDevModel> = {
    output: {
      id: "output",
      name: "Output",
      attachment: false,
      modalities: { input: ["text"], output: ["image", "video"] },
    },
    vision: {
      id: "vision",
      name: "Vision",
      attachment: false,
      modalities: { input: ["text", "image"], output: ["text"] },
    },
    fast: { id: "fast", name: "Fast", reasoning: false },
  };
  const caps = transformModelsDevToCapabilities({ fixture: { id: "fixture", models } }).fixture;
  assert.equal(caps.output.attachment, false);
  assert.equal(caps.vision.attachment, true);
  assert.equal(caps.fast.model_type, null);
});
