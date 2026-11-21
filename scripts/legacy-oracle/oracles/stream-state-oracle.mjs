import { writeFileSync } from "node:fs";
Date.now = () => 1_700_000_000_000;
const m = await import(`${process.argv[2]}/open-sse/translator/response/openai-responses/synthesizeCompletedToolCalls.ts`);

const baseState = (extra = {}) => ({ chatId: "chatcmpl-1", created: 7, model: "gpt-x", toolCallIndex: 0, currentToolCallId: null, toolCallIdsSeen: [], finishReasonSent: false, roleEmitted: false, ...extra });
const toLegacy = (s) => ({ ...s, toolCallIdsSeen: new Set(s.toolCallIdsSeen), toolSchemas: s.toolSchemas ? new Map(Object.entries(s.toolSchemas)) : undefined });
const schema = { properties: { path: { type: "string" }, opt: { type: "string" } }, required: ["path"] };

const fc = (extra) => ({ type: "function_call", ...extra });
const synth = [
  [baseState(), []],
  [baseState(), "nope"],
  [baseState(), [{ type: "message" }]],
  [baseState(), [fc({ call_id: "c1", name: "get", arguments: "{\"a\":1}" })]],
  [baseState({ usage: { total_tokens: 3 } }), [fc({ call_id: "c1", name: "get", arguments: "{}" })]],
  [baseState({ usage: [1] }), [fc({ call_id: "c1", name: "get", arguments: "{}" })]],
  [baseState({ usage: null }), [fc({ call_id: "c1", name: "get", arguments: "{}" })]],
  [baseState({ model: "" }), [fc({ call_id: "c1", name: "get" })]],
  [baseState({ model: null }), [fc({ call_id: "c1", name: " spaced " })]],
  [baseState({ toolCallIdsSeen: ["c1"] }), [fc({ call_id: "c1", name: "get", arguments: "{}" })]],
  [baseState({ toolCallIdsSeen: ["c1"] }), [fc({ call_id: "c1", name: "get" }), fc({ call_id: "c2", name: "put", arguments: "{\"b\":2}" })]],
  [baseState({ finishReasonSent: true }), [fc({ call_id: "c1", name: "get" })]],
  [baseState({ toolCallIndex: 2 }), [fc({ name: "anon", arguments: "{}" })]],
  [baseState({ toolCallIndex: 1 }), [fc({ call_id: "", name: "anon" }), fc({ call_id: "c9", name: "x", arguments: { opt: "", path: "p" } })]],
  [baseState(), [fc({ call_id: "c1", name: "get", arguments: { a: 2, z: 1 } })]],
  [baseState(), [fc({ call_id: "c1", name: "get", arguments: 5 })]],
  [baseState(), [fc({ call_id: "c1", name: "get", arguments: null })]],
  [baseState(), [fc({ call_id: "c1", name: "get", arguments: "" })]],
  [baseState({ toolSchemas: { get: schema } }), [fc({ call_id: "c1", name: "get", arguments: "{\"path\":\"p\",\"opt\":\"\"}" })]],
  [baseState({ toolSchemas: { get: schema } }), [fc({ call_id: "c1", name: "other", arguments: "{\"path\":\"p\",\"opt\":\"\"}" })]],
  [baseState(), [fc({ call_id: "c1", name: "Read", arguments: "{\"pages\":\"\",\"path\":\"p\"}" })]],
  [baseState(), [fc({ call_id: "c1", name: "Agent", arguments: "{\"x\":null,\"y\":1}" })]],
  [baseState(), [fc({ call_id: "c1" })]],
  [baseState({ currentToolCallId: "open" }), [fc({ call_id: "c1", name: "get" })]],
];
const synthesize = synth.map(([s, output]) => {
  const state = toLegacy(s);
  const chunks = m.synthesizeCompletedToolCalls(state, output);
  return {
    state: s, output, chunks: chunks ?? null,
    after: {
      toolCallIndex: state.toolCallIndex, currentToolCallId: state.currentToolCallId ?? null,
      currentToolCallArgsBuffer: state.currentToolCallArgsBuffer ?? "", currentToolCallDeferred: state.currentToolCallDeferred ?? false,
      finishReasonSent: state.finishReasonSent, finishReason: state.finishReason ?? null, roleEmitted: !!state.roleEmitted,
    },
  };
});
// The Rust state starts with finish_reason None and the buffer empty, as the legacy state without the field.
const chunkOf = (delta) => ({ id: "c", choices: [{ index: 0, delta, finish_reason: null }] });
const roleCases = [
  [baseState(), [chunkOf({ content: "hi" })]],
  [baseState({ roleEmitted: true }), [chunkOf({ content: "hi" })]],
  [baseState(), [{ id: "x" }, chunkOf({ content: "a" }), chunkOf({ content: "b" })]],
  [baseState(), [{ choices: [] }, { choices: [{}] }, { choices: [{ delta: [] }] }, chunkOf({ tool_calls: [] })]],
  [baseState(), [{ choices: [{ delta: "str" }] }]],
  [baseState(), [chunkOf({})]],
  [baseState(), []],
];
const role = roleCases.map(([s, chunks]) => {
  const state = toLegacy(s);
  const input = structuredClone(chunks);
  const result = m.withAssistantRoleOnFirstDelta(state, input);
  return { state: s, chunks, result: JSON.parse(JSON.stringify(result)), roleEmitted: !!state.roleEmitted };
});
const finishCases = [baseState(), baseState({ toolCallIndex: 1 }), baseState({ currentToolCallId: "x" }), baseState({ toolCallIndex: 0, currentToolCallId: "" }), baseState({ toolCallIndex: 3, currentToolCallId: "y" })];
const finish = finishCases.map((s) => ({ state: s, reason: m.computeFinishReason(toLegacy(s)) }));
writeFileSync(process.argv[3], JSON.stringify({ synthesize, role, finish }));
console.log("ok", synthesize.length, role.length, finish.length);
