import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

Date.now = () => 1_700_000_000_000;
const root = process.argv[2]; // legacy checkout directory, with forward slashes
const rootUrl = pathToFileURL(root).href.replace(/\/?$/, "/");
const source = readFileSync(`${root}/open-sse/translator/response/openai-responses.ts`, "utf8");
const start = source.indexOf("function markResponsesReasoningDeltaEmitted");
const end = source.indexOf("// Register both directions");
if (start < 0 || end < 0) throw new Error("slice markers not found");
const at = (path) => new URL(path, rootUrl).href;
const header = `
import { isInternalReasoningPlaceholder } from "${at("open-sse/utils/reasoningPlaceholder.ts")}";
import { fallbackToolCallId } from "${at("open-sse/translator/helpers/toolCallHelper.ts")}";
import { normalizeToolName, stripEmptyOptionalToolArgs, normalizeUpstreamFailure, getVisibleResponsesReasoningSummaryText } from "${at("open-sse/translator/response/openai-responses/pureHelpers.ts")}";
import { extractReplayableResponsesReasoningText } from "${pathToFileURL(resolve(process.cwd(), "replayable-stub.ts")).href}";
import { computeFinishReason, synthesizeCompletedToolCalls, withAssistantRoleOnFirstDelta } from "${at("open-sse/translator/response/openai-responses/synthesizeCompletedToolCalls.ts")}";
`;
// reasoningInputPolicy.ts imports the whole provider registry; take just the function and its helper from it.
const policy = readFileSync(`${root}/open-sse/services/reasoningInputPolicy.ts`, "utf8");
const cut = (from, to) => policy.slice(policy.indexOf(from), policy.indexOf(to, policy.indexOf(from)));
writeFileSync(resolve(process.cwd(), "replayable-stub.ts"), `type JsonRecord = Record<string, unknown>;
${cut("function asRecord(", "function isNonEmptyString")}
${cut("export function extractReplayableResponsesReasoningText", "export function hasOpaqueReasoningState")}`);
const target = resolve(process.cwd(), "openai-responses-slice.ts");
writeFileSync(target, `${header}\n${source.slice(start, end)}`);
const { openaiResponsesToOpenAIResponse: translate } = await import(pathToFileURL(target).href);

const U = undefined;
const ev = (type, extra = {}) => ({ type, ...extra });
const fcAdded = (extra = {}, data = {}) => ev("response.output_item.added", { item: { type: "function_call", ...extra }, ...data });
const fcDone = (extra = {}, data = {}) => ev("response.output_item.done", { item: { type: "function_call", ...extra }, ...data });
const argsDelta = (delta, extra = {}) => ev("response.function_call_arguments.delta", { delta, ...extra });
const completed = (response = {}) => ev("response.completed", { response });
const schema = { properties: { path: { type: "string" }, opt: { type: "string" } }, required: ["path"] };

const cases = [
  ["text deltas then completed", {}, [ev("response.output_text.delta", { delta: "Hel" }), ev("response.output_text.delta", { delta: "lo" }), ev("response.output_text.done"), completed({ model: "gpt-5", usage: { input_tokens: 3, output_tokens: 2 } }), null]],
  ["empty text delta", {}, [ev("response.output_text.delta", { delta: "" }), ev("response.output_text.delta"), null]],
  ["model from response", {}, [ev("response.created", { response: { model: " gpt-5.5 " } }), ev("response.output_text.delta", { delta: "x" })]],
  ["model from data and variants", {}, [ev("x", { model: "m1" }), ev("response.output_text.delta", { delta: "x" })]],
  ["model version variant", {}, [ev("x", { modelVersion: "mv" }), ev("response.output_text.delta", { delta: "x" })]],
  ["event field instead of type", {}, [{ event: "response.output_text.delta", delta: "via event" }]],
  ["data wrapper", {}, [{ type: "response.output_text.delta", data: { delta: "from data" } }]],
  ["usage with cache", {}, [ev("response.output_text.delta", { delta: "x" }), completed({ usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 2 } } })]],
  ["usage with cache_read key", {}, [ev("response.output_text.delta", { delta: "x" }), completed({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } })]],
  ["usage chat style", {}, [ev("response.output_text.delta", { delta: "x" }), completed({ usage: { prompt_tokens: 7, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 1 }, completion_tokens_details: { reasoning_tokens: 3 } } })]],
  ["usage empty and zero", {}, [ev("response.output_text.delta", { delta: "x" }), completed({ usage: {} })]],
  ["usage reasoning only", {}, [ev("response.output_text.delta", { delta: "x" }), completed({ usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 9 } })]],
  ["function call streamed", {}, [fcAdded({ call_id: "c1", name: "get_weather", id: "fc_1" }, { output_index: 0 }), argsDelta("{\"a\"", { item_id: "fc_1" }), argsDelta(":1}", { item_id: "fc_1" }), fcDone({ call_id: "c1", name: "get_weather", id: "fc_1", arguments: "{\"a\":1}" }), completed({})]],
  ["function call done only", {}, [fcDone({ call_id: "c2", name: "put", arguments: "{\"b\":2}" }), completed({})]],
  ["function call done only no id", {}, [fcDone({ name: "put", arguments: "{\"b\":2}" }), completed({})]],
  ["function call delta by output index", {}, [fcAdded({ call_id: "c1", name: "t" }, { output_index: 3 }), argsDelta("{\"x\":1}", { output_index: 3 }), fcDone({ call_id: "c1", name: "t" })]],
  ["function call single open fallback", {}, [fcAdded({ call_id: "c1", name: "t" }), argsDelta("{\"x\":1}"), fcDone({ call_id: "c1", name: "t" })]],
  ["function call two open no ids falls to current", {}, [fcAdded({ call_id: "c1", name: "t" }), fcAdded({ call_id: "c2", name: "u" }), argsDelta("{\"x\":1}"), fcDone({ call_id: "c1", name: "t" }), fcDone({ call_id: "c2", name: "u" })]],
  ["parallel calls", {}, [fcAdded({ call_id: "c1", name: "a", id: "i1" }), fcAdded({ call_id: "c2", name: "b", id: "i2" }), argsDelta("{\"p\":1}", { item_id: "i2" }), argsDelta("{\"q\":2}", { item_id: "i1" }), fcDone({ call_id: "c2", name: "b" }), fcDone({ call_id: "c1", name: "a" }), completed({})]],
  ["deferred nameless call", {}, [fcAdded({ call_id: "c1", name: "" }), argsDelta("{\"k\":1}"), fcDone({ call_id: "c1", name: "late_name", arguments: "{\"k\":1}" }), completed({})]],
  ["deferred never named", {}, [fcAdded({ call_id: "c1", name: " " }), fcDone({ call_id: "c1", name: "" }), completed({})]],
  ["deferred object arguments", {}, [fcAdded({ call_id: "c1", name: "" }), fcDone({ call_id: "c1", name: "n", arguments: { a: 1 } })]],
  ["Agent normalization", {}, [fcAdded({ call_id: "c1", name: "Agent" }), argsDelta("{\"x\":null,\"y\":1}"), fcDone({ call_id: "c1", name: "Agent" })]],
  ["Read strips empty", {}, [fcAdded({ call_id: "c1", name: "Read" }), argsDelta("{\"pages\":\"\",\"path\":\"p\"}"), fcDone({ call_id: "c1", name: "Read" })]],
  ["schema aware strip", { toolSchemas: { t: schema } }, [fcAdded({ call_id: "c1", name: "t" }), argsDelta("{\"path\":\"p\",\"opt\":\"\"}"), fcDone({ call_id: "c1", name: "t" })]],
  ["done with arguments after deltas", {}, [fcAdded({ call_id: "c1", name: "t" }), argsDelta("{\"x\":1}"), fcDone({ call_id: "c1", name: "t", arguments: "{\"x\":1}" })]],
  ["done empty arguments no buffer", {}, [fcAdded({ call_id: "c1", name: "t" }), fcDone({ call_id: "c1", name: "t", arguments: "" })]],
  ["done no arguments at all", {}, [fcAdded({ call_id: "c1", name: "t" }), fcDone({ call_id: "c1", name: "t" })]],
  ["tool calls map kept", { withToolCalls: true }, [fcAdded({ call_id: "c1", name: "t" }), argsDelta("{\"x\":1}"), fcDone({ call_id: "c1", name: "t" })]],
  ["added twice same call", {}, [fcAdded({ call_id: "c1", name: "t" }), fcAdded({ call_id: "c1", name: "t2" }), fcDone({ call_id: "c1", name: "t2", arguments: "{}" })]],
  ["added without call id", {}, [fcAdded({ name: "anon" }), fcDone({ name: "anon", arguments: "{}" })]],
  ["completed snapshot synthesizes", {}, [completed({ output: [{ type: "function_call", call_id: "s1", name: "snap", arguments: "{\"z\":1}" }], usage: { input_tokens: 1, output_tokens: 1 } })]],
  ["completed snapshot dedup", {}, [fcAdded({ call_id: "c1", name: "t" }), fcDone({ call_id: "c1", name: "t", arguments: "{}" }), completed({ output: [{ type: "function_call", call_id: "c1", name: "t", arguments: "{}" }] })]],
  ["completed twice", {}, [ev("response.output_text.delta", { delta: "x" }), completed({}), completed({})]],
  ["flush open call", {}, [fcAdded({ call_id: "c1", name: "t" }), argsDelta("{\"x\":null}"), null]],
  ["flush no calls", {}, [ev("response.output_text.delta", { delta: "x" }), null]],
  ["flush before start", {}, [null]],
  ["flush after finish", {}, [ev("response.output_text.delta", { delta: "x" }), completed({}), null]],
  ["failed event", {}, [ev("response.failed", { response: { error: { code: "rate_limit_exceeded", message: "slow" } } }), ev("response.output_text.delta", { delta: "late" }), null]],
  ["error event", {}, [ev("error", { error: { code: "context_length_exceeded", message: "long" } })]],
  ["reasoning deltas", {}, [ev("response.reasoning_text.delta", { delta: "think", item_id: "r1" }), ev("response.reasoning_content_text.delta", { delta: "more", item_id: "r1" }), ev("response.reasoning_text.delta", { delta: "" })]],
  ["reasoning summary deltas", {}, [ev("response.reasoning_summary_text.delta", { delta: "s1", item_id: "r1", summary_index: 0 }), ev("response.reasoning_summary_text.delta", { delta: "s2", item_id: "r1", summary_index: 1 }), ev("response.reasoning_summary_text.delta", { delta: "s2b", item_id: "r1", summary_index: 1 }), ev("response.reasoning_summary_text.delta", { delta: "other", item_id: "r2", summary_index: 0 })]],
  ["reasoning summary no index", {}, [ev("response.reasoning_summary_text.delta", { delta: "a", item_id: "r1" }), ev("response.reasoning_summary_text.delta", { delta: "b", item_id: "r1", summary_index: 3 }), ev("response.reasoning_summary_text.delta", { delta: "c", item_id: "r1", summary_index: 4 })]],
  ["reasoning summary no item id", {}, [ev("response.reasoning_summary_text.delta", { delta: "a", summary_index: 0 }), ev("response.reasoning_summary_text.delta", { delta: "b", summary_index: 1 })]],
  ["reasoning summary copilot", { copilot: true }, [ev("response.reasoning_summary_text.delta", { delta: "viaCopilot", item_id: "r1", summary_index: 0 })]],
  ["reasoning summary placeholder", {}, [ev("response.reasoning_summary_text.delta", { delta: "(prior reasoning summary unavailable)", item_id: "r1", summary_index: 0 })]],
  ["reasoning done synthesizes", {}, [ev("response.output_item.done", { item: { type: "reasoning", id: "rs1", content: [{ type: "reasoning_text", text: "plain thought" }] } })]],
  ["reasoning done accumulates", {}, [ev("response.output_item.done", { item: { type: "reasoning", id: "rs1", content: [{ type: "reasoning_text", text: "one" }] } }), ev("response.output_item.done", { item: { type: "reasoning", id: "rs2", content: [{ type: "reasoning_text", text: "two" }] } })]],
  ["reasoning done skipped after delta same item", {}, [ev("response.reasoning_text.delta", { delta: "d", item_id: "rs1" }), ev("response.output_item.done", { item: { type: "reasoning", id: "rs1", content: [{ type: "reasoning_text", text: "d" }] } })]],
  ["reasoning done skipped after delta no id", {}, [ev("response.reasoning_text.delta", { delta: "d" }), ev("response.output_item.done", { item: { type: "reasoning", id: "rs1", content: [{ type: "reasoning_text", text: "d" }] } })]],
  ["reasoning done delta other item", {}, [ev("response.reasoning_text.delta", { delta: "d", item_id: "rsA" }), ev("response.output_item.done", { item: { type: "reasoning", id: "rsB", content: [{ type: "reasoning_text", text: "other" }] } })]],
  ["reasoning done summary only", {}, [ev("response.output_item.done", { item: { type: "reasoning", id: "rs1", summary: [{ text: "sa" }, { text: "sb" }] } })]],
  ["reasoning done encrypted only", {}, [ev("response.output_item.done", { item: { type: "reasoning", id: "rs1", encrypted_content: "xyz", summary: [] } })]],
  ["role announced once", {}, [ev("response.output_text.delta", { delta: "a" }), ev("response.output_text.delta", { delta: "b" })]],
  ["role on first emitting event", {}, [fcAdded({ call_id: "c1", name: "" }), ev("response.output_text.delta", { delta: "a" })]],
  ["unknown events ignored", {}, [ev("response.created"), ev("response.in_progress"), ev("response.content_part.added"), ev("response.output_text.delta", { delta: "ok" })]],
  ["falsy chunk values", {}, [ev("response.output_text.delta", { delta: "x" }), 0, "", false, null]],
];

const out = cases.map(([name, init, events]) => {
  const state = {};
  if (init.copilot) state.copilotCompatibleReasoning = true;
  if (init.toolSchemas) state.toolSchemas = new Map(Object.entries(init.toolSchemas));
  if (init.withToolCalls) state.toolCalls = new Map();
  const chunks = events.map((event) => {
    const result = translate(event === null || event === 0 || event === "" || event === false ? event : structuredClone(event), state);
    if (result === null || result === undefined) return [];
    return JSON.parse(JSON.stringify(Array.isArray(result) ? result : [result]));
  });
  return {
    name, state: init, events: events.map((e) => (e === 0 || e === "" || e === false ? null : e)), chunks,
    finishReasonSent: !!state.finishReasonSent, finishReason: state.finishReason ?? null,
    accumulatedReasoning: state.accumulatedReasoning ?? "", usage: state.usage ?? null,
    upstreamStatus: state.upstreamError ? state.upstreamError.status : null,
  };
});
writeFileSync(process.argv[3], JSON.stringify(out));
console.log("ok", out.length);
