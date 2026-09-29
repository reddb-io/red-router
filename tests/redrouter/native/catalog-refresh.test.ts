// Catalog refresh aligned with 9router v0.5.91: OpenCode Go/Zen/Free additions, Codex base
// models, the DeepSeek V4.x effort ladder and the zero-cost `cline-free/` namespace.
import assert from "node:assert/strict";
import test from "node:test";
import { REGISTRY } from "../../../open-sse/config/providerRegistry.ts";
import { getModelTargetFormat } from "../../../open-sse/config/providerModels.ts";
import { parseEffortLevel } from "../../../open-sse/executors/opencode.ts";
import {
  FREE_MODEL_NAMESPACES,
  calculateCost,
  calculateCostDetailed,
  isFreeModel,
} from "../../../src/lib/usage/costCalculator.ts";

type Row = {
  id: string;
  targetFormat?: string;
  supportsVision?: boolean;
  supportedThinkingEfforts?: readonly string[];
};

const rows = (provider: string): Row[] => (REGISTRY[provider]?.models ?? []) as Row[];
const count = (provider: string, id: string) => rows(provider).filter((m) => m.id === id).length;
const row = (provider: string, id: string) => rows(provider).find((m) => m.id === id);

const GO_ADDED = [
  "deepseek-flash",
  "deepseek-v4.1-flash",
  "deepseek-v4-flash-vision-exp",
  "glm-5.3",
  "glm-5.3-flash",
  "gpt-6-luna",
  "grok-4.7",
  "hy4-preview",
  "longcat-2.0",
  "omen-alpha",
  "space-bunny-free",
  "qwen3.8-flash",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
];
const ZEN_ADDED = ["union-alpha", "mimo-v2.6-flash-free", "ling-3.0-flash-fin-free"];
const CODEX_ADDED = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"];
const LADDER = ["none", "low", "medium", "high", "xhigh", "max"];

test("opencode-go carries every id added by the 0.5.91 refresh exactly once", () => {
  for (const id of GO_ADDED) assert.equal(count("opencode-go", id), 1, id);
});

test("opencode-go registry ids stay unique", () => {
  const ids = rows("opencode-go").map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("opencode-go serves gpt-6-luna, grok-4.7 on the Responses API only", () => {
  assert.equal(row("opencode-go", "gpt-6-luna")?.targetFormat, "openai-responses");
  assert.equal(row("opencode-go", "grok-4.7")?.targetFormat, "openai-responses");
  assert.equal(getModelTargetFormat("opencode-go", "gpt-6-luna"), "openai-responses");
});

test("opencode-go claude-capable additions route through /messages", () => {
  assert.equal(row("opencode-go", "space-bunny-free")?.targetFormat, "claude");
  assert.equal(row("opencode-go", "qwen3.8-flash")?.targetFormat, "claude");
});

test("opencode-zen carries union-alpha, mimo-v2.6-flash-free and ling-3.0-flash-fin-free once", () => {
  for (const id of ZEN_ADDED) assert.equal(count("opencode-zen", id), 1, id);
});

test("union-alpha is served through the Messages API on the Zen tiers", () => {
  assert.equal(row("opencode-zen", "union-alpha")?.targetFormat, "claude");
  assert.equal(row("opencode", "union-alpha")?.targetFormat, "claude");
  assert.equal(count("opencode", "union-alpha"), 1);
});

test("codex carries the base gpt-5.4 family once and none of the -review/-image ids", () => {
  for (const id of CODEX_ADDED) assert.equal(count("codex", id), 1, id);
  const ids = rows("codex").map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of CODEX_ADDED) {
    assert.equal(ids.includes(`${id}-review`), false, `${id}-review`);
    assert.equal(ids.includes(`${id}-image`), false, `${id}-image`);
  }
});

test("deepseek-v4.* declares the none..max effort ladder", () => {
  assert.deepEqual(row("deepseek", "deepseek-v4.1-flash")?.supportedThinkingEfforts, LADDER);
  assert.deepEqual(row("opencode-go", "deepseek-v4.1-flash")?.supportedThinkingEfforts, LADDER);
  assert.equal(count("deepseek", "deepseek-v4.1-flash"), 1);
});

test("opencode-go effort-suffixed deepseek-v4.1-flash ids resolve to the base model", () => {
  for (const effort of LADDER) {
    assert.deepEqual(parseEffortLevel(`deepseek-v4.1-flash-${effort}`), {
      baseModel: "deepseek-v4.1-flash",
      effort,
    });
  }
});

test("cline-free/* is priced at zero and is not left unpriced", async () => {
  assert.deepEqual(FREE_MODEL_NAMESPACES, ["cline-free/"]);
  assert.equal(isFreeModel("cline-free/deepseek-v4.1-flash"), true);
  assert.equal(isFreeModel("CLINE-FREE/gemini-3.8-flash"), true);
  assert.equal(isFreeModel("deepseek/deepseek-v4.1-flash"), false);
  assert.equal(isFreeModel(""), false);

  const tokens = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };
  for (const model of ["cline-free/deepseek-v4.1-flash", "cline-free/muse-spark-1.3-contributor"]) {
    assert.deepEqual(await calculateCostDetailed("cline", model, tokens), {
      costUsd: 0,
      priced: true,
    });
    assert.equal(await calculateCost("cline", model, tokens), 0);
  }
});
