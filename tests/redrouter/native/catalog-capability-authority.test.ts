import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ModelCapabilityEntry } from "../../../src/lib/modelsDevSync/transform.ts";
import type { ModelCapabilityResolutionSnapshot } from "../../../src/lib/modelCapabilityResolutionSnapshot.ts";
import { getResolvedModelCapabilities } from "../../../src/lib/modelCapabilities.ts";
import {
  __test_resetLearnedReasoningEffortCaps,
  getLearnedReasoningEffortForModel,
  recordLearnedReasoningEffort,
} from "../../../open-sse/services/learnedReasoningEffortCaps.ts";
import { buildSyncedCapabilities } from "../../../src/app/api/v1/models/syncedCapabilities.ts";
import { enrichCatalogModelEntry } from "../../../src/lib/modelMetadataRegistry.ts";

const capability = (fields: Partial<ModelCapabilityEntry> = {}): ModelCapabilityEntry => ({
  tool_call: null,
  reasoning: null,
  attachment: null,
  structured_output: null,
  temperature: null,
  modalities_input: "[]",
  modalities_output: "[]",
  knowledge_cutoff: null,
  release_date: null,
  last_updated: null,
  status: null,
  family: null,
  open_weights: null,
  limit_context: null,
  limit_input: null,
  limit_output: null,
  interleaved_field: null,
  ...fields,
});
const snapshot = (
  provider: string,
  model: string,
  fields: Partial<ModelCapabilityEntry> = {}
): ModelCapabilityResolutionSnapshot => ({
  synced: { [provider]: { [model]: capability(fields) } },
  maxTokenOverrides: new Map(),
  maxInputTokenOverrides: new Map(),
  reasoningEffortsOverrides: new Map(),
  contextOverrides: new Map(),
  customVisionOverrides: new Map(),
  syncedAvailableModelVision: new Map(),
});
const resolve = (provider: string, model: string, fields: Partial<ModelCapabilityEntry>) =>
  getResolvedModelCapabilities({ provider, model }, undefined, snapshot(provider, model, fields));
beforeEach(__test_resetLearnedReasoningEffortCaps);

test("a hard adapter tool prohibition wins over positive synced metadata", () => {
  const result = resolve("aihorde", "private-model", { tool_call: true });
  assert.equal(result.supportsTools, false);
  assert.equal(result.toolCalling, false);
});

test("vision means image/video input, never generated image output", () => {
  const provider = "openai-compatible-chat-authority";
  const imageOutput = resolve(provider, "private-generator", {
    attachment: false,
    modalities_input: '["text"]',
    modalities_output: '["image"]',
  });
  assert.equal(imageOutput.supportsVision, false);
  const imageInput = resolve(provider, "private-reader", {
    attachment: false,
    modalities_input: '["text","image"]',
    modalities_output: '["text"]',
  });
  assert.equal(imageInput.supportsVision, true);
  assert.equal(imageInput.attachment, true);

  const explicit = snapshot(provider, "private-generator", {
    attachment: false,
    modalities_input: '["text"]',
    modalities_output: '["image"]',
  });
  (explicit.customVisionOverrides as Map<string, Map<string, boolean>>).set(
    provider,
    new Map([["private-generator", true]])
  );
  assert.equal(
    getResolvedModelCapabilities({ provider, model: "private-generator" }, undefined, explicit)
      .supportsVision,
    true,
    "the operator's explicit custom capability remains authoritative"
  );
});

test("a bundled fact only fills unknown adapter capabilities and token limits", () => {
  const provider = "openai";
  const model = "gpt-4o";
  const baseline = resolve(provider, model, {});
  const seed = resolve(provider, model, {
    metadata_source: "models-dev-bundled",
    tool_call: false,
    reasoning: true,
    attachment: false,
    modalities_input: '["text"]',
    limit_context: 1,
    limit_output: 1,
  });
  for (const field of [
    "supportsTools",
    "supportsThinking",
    "supportsVision",
    "contextWindow",
    "maxOutputTokens",
  ] as const) {
    if (baseline[field] !== null) assert.equal(seed[field], baseline[field], field);
  }
});

test("native reasoning options retain exact values without becoming wire effort authority", () => {
  const options = [
    { type: "toggle" },
    { type: "effort", values: [null, "none", "high", "max"] },
    { type: "budget_tokens", min: 512, max: 8192 },
  ];
  const result = resolve("openai-compatible-chat-options", "private-reasoner", {
    reasoning: true,
    reasoning_options: JSON.stringify(options),
  });
  assert.deepEqual(result.reasoningOptions, options);
  assert.equal(result.supportedThinkingEfforts, null);
  assert.deepEqual(
    resolve("openai-compatible-chat-options", "private-reasoner", {
      reasoning: true,
      reasoning_options: "[]",
    }).reasoningOptions,
    []
  );
  const invalid = resolve("openai-compatible-chat-options", "private-invalid", {
    reasoning_options: JSON.stringify([{ type: "effort", values: [12] }]),
  });
  assert.equal(invalid.reasoningOptions, null);
  const decision = resolve("openai-compatible-chat-options", "private-decision", {
    model_type: "decision",
    reasoning: true,
    tool_call: true,
  });
  assert.equal(decision.supportsTools, false);
  assert.equal(decision.supportsThinking, false);
  const overriddenDecision = snapshot("openai-compatible-chat-options", "private-decision", {
    model_type: "decision",
    reasoning: true,
  });
  (overriddenDecision.reasoningEffortsOverrides as Map<string, Map<string, string[]>>).set(
    "openai-compatible-chat-options",
    new Map([["private-decision", ["high"]]])
  );
  const decisionWithOverride = getResolvedModelCapabilities(
    { provider: "openai-compatible-chat-options", model: "private-decision" },
    undefined,
    overriddenDecision
  );
  assert.equal(decisionWithOverride.supportsThinking, false);
  assert.equal(decisionWithOverride.supportedThinkingEfforts, null);
});

test("learned effort enums stay within the execution provider, including custom display prefixes", () => {
  recordLearnedReasoningEffort("gateway-a", "private-reasoner", ["low", "high"]);
  recordLearnedReasoningEffort("gateway-b", "private-reasoner", ["medium", "max"]);
  assert.equal(getLearnedReasoningEffortForModel("private-reasoner"), null);
  assert.deepEqual(
    [...getLearnedReasoningEffortForModel("private-reasoner", ["gateway-a"])!],
    ["low", "high"]
  );
  const row = {
    id: "private-reasoner",
    supportsThinking: true,
    supportedThinkingEfforts: ["low", "medium", "high", "max"],
  };
  assert.deepEqual(buildSyncedCapabilities(row, "custom-name", "gateway-a")?.effort_tiers, [
    "low",
    "high",
  ]);
  assert.deepEqual(buildSyncedCapabilities(row, "custom-name", "gateway-b")?.effort_tiers, [
    "medium",
    "max",
  ]);
  assert.deepEqual(
    buildSyncedCapabilities(row, "custom-name", "gateway-c")?.effort_tiers,
    row.supportedThinkingEfforts
  );
  assert.deepEqual(buildSyncedCapabilities(row, "codex", "gateway-a")?.effort_tiers, [
    "low",
    "high",
  ]);
});

test("metadata-only reasoning never synthesizes efforts, including an empty native option list", () => {
  const provider = "openai-compatible-chat-descriptive";
  const model = "private-reasoner";
  for (const source of [undefined, "models-dev-bundled", "models-dev"]) {
    for (const options of [
      undefined,
      [],
      [{ type: "toggle" }],
      [{ type: "budget_tokens", min: 512, max: 8192 }],
      [{ type: "effort", values: [null, "max"] }],
    ]) {
      const capabilityResolutionSnapshot = snapshot(provider, model, {
        metadata_source: source,
        reasoning: true,
        ...(options ? { reasoning_options: JSON.stringify(options) } : {}),
      });
      const enriched = enrichCatalogModelEntry(
        { id: `${provider}/${model}`, root: model, owned_by: provider },
        { provider, model },
        {
          modelsDevPricing: null,
          effectivePricing: {},
          userPricing: {},
          capabilityResolutionSnapshot,
        }
      ) as Record<string, unknown>;
      const capabilities = enriched.capabilities as Record<string, unknown>;
      assert.equal(capabilities.thinking, true);
      assert.equal(capabilities.effort_tiers, undefined, `${source}: ${JSON.stringify(options)}`);
      if (options) assert.deepEqual(enriched.reasoning_options, options);
    }
  }
});

test("native reasoning option presence blocks generic inference on known models but preserves explicit contracts", () => {
  const enrich = (
    provider: string,
    model: string,
    fields: Partial<ModelCapabilityEntry>,
    entryFields: Record<string, unknown> = {},
    capabilityResolutionSnapshot = snapshot(provider, model, fields)
  ) =>
    enrichCatalogModelEntry(
      { id: `${provider}/${model}`, root: model, owned_by: provider, ...entryFields },
      { provider, model },
      {
        modelsDevPricing: null,
        effectivePricing: {},
        userPricing: {},
        capabilityResolutionSnapshot,
      }
    ) as Record<string, unknown>;
  for (const options of [[], [{ type: "toggle" }]]) {
    const known = enrich("openai", "o3", {
      metadata_source: "models-dev",
      reasoning: true,
      reasoning_options: JSON.stringify(options),
    });
    assert.equal((known.capabilities as Record<string, unknown>).thinking, true);
    assert.equal((known.capabilities as Record<string, unknown>).effort_tiers, undefined);
  }

  const fields = { metadata_source: "models-dev", reasoning: true, reasoning_options: "[]" };
  const connection = enrich("openai-compatible-chat-descriptive", "private-reasoner", fields, {
    capabilities: { effort_tiers: ["low", "max"] },
  });
  assert.deepEqual((connection.capabilities as Record<string, unknown>).effort_tiers, [
    "low",
    "max",
  ]);
  const adapter = enrich("openai", "gpt-6-astra", fields);
  assert.deepEqual((adapter.capabilities as Record<string, unknown>).effort_tiers, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  const emptyAdapter = enrich("zcode", "glm-5.3", fields, {
    capabilities: { effort_tiers: ["high"] },
  });
  assert.deepEqual((emptyAdapter.capabilities as Record<string, unknown>).effort_tiers, []);
  const emptyConnection = enrich("openai-compatible-chat-descriptive", "private-reasoner", fields, {
    capabilities: { effort_tiers: [] },
  });
  assert.deepEqual((emptyConnection.capabilities as Record<string, unknown>).effort_tiers, []);

  const provider = "openai-compatible-chat-descriptive";
  const model = "private-reasoner";
  const override = snapshot(provider, model, fields);
  (override.reasoningEffortsOverrides as Map<string, Map<string, string[]>>).set(
    provider,
    new Map([[model, ["high"]]])
  );
  const overridden = enrich(provider, model, fields, {}, override);
  assert.deepEqual((overridden.capabilities as Record<string, unknown>).effort_tiers, ["high"]);

  const direct = enrich("openai", "o3", { reasoning: true }, { reasoning_options: [] });
  assert.equal((direct.capabilities as Record<string, unknown>).effort_tiers, undefined);
});
