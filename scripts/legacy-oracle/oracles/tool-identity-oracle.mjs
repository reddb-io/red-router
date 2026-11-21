import { writeFileSync } from "node:fs";
const base = process.argv[2];
const req = await import(`${base}/open-sse/translator/response/openai-responses/requestToolIdentity.ts`);
const fci = await import(`${base}/open-sse/translator/response/openai-responses/functionCallIdentity.ts`);
const idx = await import(`${base}/open-sse/translator/response/openai-responses/toolCallLocalIndex.ts`);

const ledger = {
  mcp__srv__read: { namespace: "mcp__srv", name: "read" },
  plain_tool: { namespace: "ns", name: "leaf" },
  bad_ns: { namespace: "", name: "x" },
  bad_name: { namespace: "n", name: "" },
  not_object: "str",
  arr: [1],
};
const maps = [
  null, {}, ledger,
  { only_one: { namespace: "collaboration", name: "spawn_agent" } },
  { x: { namespace: "mcp__a", name: "b" } },
];
const names = [
  "", "mcp__srv__read", "plain_tool", "bad_ns", "bad_name", "not_object", "arr", "ns.leaf", "mcp__srv.read",
  "mcp__a__b", "mcp__a", "mcp__", "mcp____x", "mcp__a__", "other__b__c", "mcp__x__y__z", "unknown", "collaboration.spawn_agent",
  "mcp__a.b",
];
const resolve = [];
for (const map of maps) {
  for (const name of names) {
    resolve.push([map, name, req.resolveRequestToolIdentity(map, name) ?? null]);
  }
}
const applyCases = [
  [ledger, "mcp__srv__read", { type: "function_call", name: "mcp__srv__read" }],
  [{}, "mcp__a__b", { type: "function_call", name: "mcp__a__b" }],
  [{ c: { namespace: "collaboration", name: "spawn_agent" } }, "c", { name: "c" }],
  [{ c: { namespace: "collaboration", name: "send_message" } }, "c", { name: "c" }],
  [{ c: { namespace: "collaboration", name: "followup_task" } }, "c", { name: "c" }],
  [{ c: { namespace: "collaboration", name: "other" } }, "c", { name: "c" }],
  [{}, "x", { namespace: "collaboration", name: "spawn_agent" }],
  [{}, "x", { namespace: "other", name: "spawn_agent" }],
  [{}, "unknown", { name: "unknown" }],
  [null, "unknown", { name: "unknown" }],
];
const apply = applyCases.map(([map, name, item]) => {
  const copy = structuredClone(item);
  fci.applyFunctionCallIdentity(copy, map, name);
  return [map, name, item, copy];
});
const state = {};
const order = ["1", "2", "1", "5", "0", "2", "7", "5", "10"];
const index = order.map((key) => [key, idx.resolveLocalToolCallIndex(state, key)]);
writeFileSync(process.argv[3], JSON.stringify({ resolve, apply, index }));
console.log("ok", resolve.length, apply.length, index.length);
