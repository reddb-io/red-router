import { writeFileSync } from "node:fs";
const base = process.argv[2];
const args = await import(`${base}/open-sse/utils/toolCallArguments.ts`);
const term = await import(`${base}/open-sse/translator/helpers/responsesTerminalStatus.ts`);
const toolItem = await import(`${base}/open-sse/translator/response/responsesToolItem.ts`);
const U = "__undefined";
const un = (v) => (v === U ? undefined : v);
const appendCases = [
  [U, "abc"], ["", "abc"], ["abc", U], ["abc", ""], ["abc", "abc"], ["abc", "abcdef"], ["abcdef", "abc"],
  ["ls -l", "l"], ["x", "x"], ["xx", "x"], ["{\"a\":", "1}"], ["{\"a\":1", "{\"a\":1,\"b\":2}"],
  [5, "abc"], ["abc", 5], ["abc", null], [null, null], ["a", { b: 1 }], ["", [1, 2]], ["a", true],
];
const terminalCases = [
  [null, false], ["stop", false], ["length", false], ["content_filter", false], ["pause_turn", false],
  ["tool_calls", false], ["length", true], ["pause_turn", true], [null, true],
];
const itemCases = [
  ["call_1", "get_weather", false, null], ["call_2", "apply_patch", true, null], ["c", "t", false, "ns"],
  ["c", "t", true, "ns"], ["c", "t", false, ""],
];
const out = {
  append: appendCases.map(([a, b]) => [a, b, args.appendToolCallArgumentDelta(un(a), un(b))]),
  terminal: terminalCases.map(([reason, error]) => {
    const response = { status: "completed" };
    const event = term.finalizeResponsesTerminalStatus(response, reason, error);
    return [reason, error, { event, response }];
  }),
  item: itemCases.map(([id, name, custom, ns]) => [id, name, custom, ns, toolItem.buildResponsesToolCallItem({ callId: id, toolName: name, custom, namespace: ns })]),
};
writeFileSync(process.argv[3], JSON.stringify(out));
console.log("ok", out.append.length, out.terminal.length, out.item.length);
