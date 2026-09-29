import assert from "node:assert/strict";
import { test } from "node:test";

const { comboMemberIds, comboStrategyForClients } =
  await import("../../../src/app/api/v1/models/catalogComboRouting.ts");

test("the priority strategy is advertised under its v0.33.0 name, with the raw one kept", () => {
  assert.deepEqual(comboStrategyForClients("priority"), {
    strategy: "fallback",
    routing_strategy: "priority",
  });
  assert.equal(comboStrategyForClients("round-robin").strategy, "round-robin");
  assert.equal(comboStrategyForClients("fusion").strategy, "fusion");
  assert.equal(comboStrategyForClients("auto").strategy, "auto");
});

test("a combo without a strategy is a priority (fallback) combo", () => {
  assert.equal(comboStrategyForClients(undefined).strategy, "fallback");
});

test("members are ordered, prefixed like the catalog ids and never repeated", () => {
  const prefixes: Record<string, string> = { claude: "claude", "node-uuid": "myproxy" };
  const members = comboMemberIds(
    [
      { providerId: "claude", modelId: "claude-opus-5-5" },
      { providerId: "node-uuid", modelId: "x/y" },
      { providerId: "claude", modelId: "claude-opus-5-5" },
    ],
    (providerId) => prefixes[providerId] ?? providerId
  );
  assert.deepEqual(members, ["claude/claude-opus-5-5", "myproxy/x/y"]);
});
