import { comboRuntimeConfigSchema } from "../../../src/shared/validation/schemas/combo.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { projectConnectionModels } from "../../../src/lib/providerModels/selection.ts";
import {
  canEvaluateJevModel,
  parseJevRoutingConfig,
} from "../../../open-sse/services/combo/jevConfig.ts";

const models = [
  { id: "typesafe/jev-1.13", supportedEndpoints: ["chat"] }, // stale sync cannot turn S1 into S2
  { id: "example/reasoner", capabilities: { reasoning: true, tool_calling: true, vision: true } },
];
test("OpenRouter selection separates decision models from reasoning/chat models", () => {
  assert.deepEqual(
    projectConnectionModels("openrouter", "openrouter", models, ["decision"]).map(
      (row) => row.fullModel
    ),
    ["openrouter/typesafe/jev-1.13"]
  );
  assert.deepEqual(
    projectConnectionModels("openrouter", "openrouter", models, [
      "chat",
      "reasoning",
      "tools",
      "vision",
    ]).map((row) => row.fullModel),
    ["openrouter/example/reasoner"]
  );
});
test("connection selection preserves federation hops and authoritative decision capability", () => {
  const rows = projectConnectionModels(
    "red-router",
    "red",
    [
      { id: "red/openrouter/typesafe/jev-1.13", capabilities: { decision: true, reasoning: true } },
      { id: "claude/reasoner", type: "chat", capabilities: { reasoning: true } },
    ],
    ["decision"]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fullModel, "red/red/openrouter/typesafe/jev-1.13");
  assert.equal((rows[0].capabilities as Record<string, unknown>).reasoning, false);
});
test("compatible connections use their configured public prefix", () => {
  assert.equal(
    projectConnectionModels("node-uuid", "private", [{ id: "model" }], ["chat"])[0].fullModel,
    "private/model"
  );
});
test("a pinned S1 connection cannot escape key/quota policy", async () => {
  const config = parseJevRoutingConfig({
    autoConfig: {
      decision: { mode: "jev", model: "openrouter/typesafe/jev-1.13", connectionId: " chosen " },
    },
  });
  assert.equal(config.connectionId, "chosen");
  let evaluated = false;
  assert.equal(
    await canEvaluateJevModel(config, ["other"], async () => {
      evaluated = true;
      return true;
    }),
    false
  );
  assert.equal(evaluated, false);
  assert.equal(await canEvaluateJevModel(config, ["chosen"], async () => true), true);
  assert.equal(parseJevRoutingConfig({}).connectionId, undefined);
});

test("federated evaluator IDs use the public 2048-character bound", () => {
  assert.equal(
    comboRuntimeConfigSchema.safeParse({
      decision: { mode: "jev", model: "red/" + "x".repeat(2044) },
    }).success,
    true
  );
  assert.equal(
    comboRuntimeConfigSchema.safeParse({ decision: { mode: "jev", model: "x".repeat(2049) } })
      .success,
    false
  );
});
