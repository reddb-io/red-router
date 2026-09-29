import assert from "node:assert/strict";
import { test } from "node:test";

const specs = await import("../../../src/shared/constants/modelSpecs.ts");
const { KNOWN_MODEL_PRICING } = await import("../../../open-sse/services/providerCostData.ts");
const { modelHasNativeContext1m } =
  await import("../../../open-sse/config/claudeCodeCompatibleIdentity.ts");
const { claudeProvider: claude } =
  await import("../../../open-sse/config/providers/registry/claude/index.ts");

test("Claude Opus 5.5 is listed with the full effort ladder and a 1M context", () => {
  const entry = (claude.models as { id: string }[]).find((model) => model.id === "claude-opus-5-5");
  assert.ok(entry, "claude-opus-5-5 is in the Claude registry");
  assert.deepEqual((entry as { supportedThinkingEfforts?: string[] }).supportedThinkingEfforts, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal((entry as { contextLength?: number }).contextLength, 1_000_000);
  // The models Opus 5 already listed stay listed.
  assert.ok((claude.models as { id: string }[]).some((model) => model.id === "claude-opus-5"));
});

test("thinking cannot be disabled and a forced tool choice is not sent to Opus 5.5", () => {
  const spec = specs.getModelSpec("claude-opus-5-5");
  assert.equal(spec?.rejectsThinkingDisabled, true);
  assert.equal(spec?.rejectsForcedToolChoice, true);
  const body = { thinking: { type: "disabled" }, tools: [{ name: "a" }], tool_choice: { type: "any" } };
  assert.equal("thinking" in specs.normalizeThinkingForModel(body, "claude-opus-5-5"), false);
  const normalized = specs.normalizeForcedToolChoiceForModel(body, "claude-opus-5-5") as {
    tool_choice?: { type?: string };
  };
  assert.notEqual(normalized.tool_choice?.type, "any");
  // Opus 5 keeps accepting a forced tool choice.
  const unchanged = specs.normalizeForcedToolChoiceForModel(body, "claude-opus-5") as {
    tool_choice?: { type?: string };
  };
  assert.equal(unchanged.tool_choice?.type, "any");
});

test("Opus 5.5 is priced and has a native 1M context that the beta header must not touch", () => {
  assert.deepEqual(
    [KNOWN_MODEL_PRICING["claude-opus-5-5"].inputCostPer1M, KNOWN_MODEL_PRICING["claude-opus-5-5"].outputCostPer1M],
    [4, 20]
  );
  assert.equal(modelHasNativeContext1m("claude-opus-5-5"), true);
  assert.equal(modelHasNativeContext1m("claude-opus-5-5-20260901"), true);
  assert.equal(modelHasNativeContext1m("claude-opus-4-8"), false);
});
