import { writeFileSync } from "node:fs";
Date.now = () => 0;
Math.random = () => 0.5;
const m = await import(process.argv[2]);
const f = m.openaiToOpenAIResponsesRequest;
const img = "data:image/png;base64,AAAA";
const cases = [
  ["empty body", "gpt-5", {}],
  ["system string", "gpt-5", { messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }] }],
  ["system parts", "gpt-5", { messages: [{ role: "system", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }, "c"] }, { role: "user", content: "hi" }] }],
  ["second system becomes developer", "gpt-5", { messages: [{ role: "system", content: "one" }, { role: "user", content: "x" }, { role: "developer", content: "two" }] }],
  ["user parts", "gpt-5", { messages: [{ role: "user", content: [
    { type: "text", text: "t" }, { type: "image_url", image_url: "http://x/a.png" }, { type: "image_url", image_url: { url: "http://x/b.png", detail: "high" } },
    { type: "image_url", image_url: {} }, { type: "image_url", image_url: { url: "u", detail: null } }, { type: "image_url" },
    { type: "image", image: img }, { type: "image", image: img, detail: "low" }, { type: "image", image: "not-a-data-url" },
    { type: "file", file: { file_data: "d", filename: "f.pdf" } }, { type: "document", document: { data: "dd", url: "http://u", name: "n" } },
    { type: "file", file: { file_id: "id1", file_url: "fu", filename: "fn", data: "ignored" } }, { type: "file" },
    { type: "weird", x: 1 }, "bare",
  ] }] }],
  ["user non-array", "gpt-5", { messages: [{ role: "user" }, { role: "user", content: 5 }] }],
  ["assistant text and tool calls", "gpt-5", { messages: [
    { role: "user", content: "q" },
    { role: "assistant", content: "answer", tool_calls: [
      { id: "call_1", function: { name: "get_weather", arguments: "{\"a\":1}" } },
      { function: { name: " spaced ", arguments: { not: "string" } } },
      { id: "  ", function: { name: "noid" } },
      { id: "skip", function: { name: "  " } },
      { id: "x".repeat(80), function: { name: "long" } },
    ] },
    { role: "tool", tool_call_id: "call_1", content: "sunny" },
    { role: "tool", tool_call_id: "x".repeat(80), content: [{ type: "text", text: "p" }, { type: "image_url" }] },
    { role: "tool", tool_call_id: "orphan", content: "gone" },
    { role: "tool", content: "no id" },
    { role: "tool", tool_call_id: "call_1", content: null },
    { role: "tool", tool_call_id: "call_1", content: 42 },
    { role: "tool", tool_call_id: "call_1", content: { a: 1 } },
  ] }],
  ["assistant parts", "gpt-5", { messages: [{ role: "assistant", content: [
    { type: "text", text: "a" }, { type: "image_url", image_url: { url: "http://i" } }, { type: "image_url" },
    { type: "thinking", thinking: "t" }, { type: "redacted_thinking" }, { type: "other", v: 1 },
  ] }] }],
  ["assistant reasoning", "gpt-5", { messages: [{ role: "assistant", content: "x", reasoning_content: "  deep  " }] }],
  ["assistant reasoning alias", "gpt-5", { messages: [{ role: "assistant", content: "x", reasoning: "alias" }] }],
  ["placeholder opencode-go", "glm-5.3", { messages: [{ role: "assistant", content: "x", reasoning_content: "(prior reasoning summary unavailable)" }] }, { provider: "opencode-go" }],
  ["placeholder mimo model", "mimo-v2", { messages: [{ role: "assistant", content: "x", reasoning_content: "(prior reasoning summary unavailable)" }] }, { provider: "other" }],
  ["placeholder elsewhere", "gpt-5", { messages: [{ role: "assistant", content: "x", reasoning_content: "(prior reasoning summary unavailable)" }] }, { provider: "deepseek" }],
  ["deprecated function_call", "gpt-5", { messages: [
    { role: "assistant", function_call: { name: "legacy_fn", arguments: "{}" } },
    { role: "function", name: "legacy_fn", content: "result" },
    { role: "function", name: "legacy_fn", content: { a: 1 } },
    { role: "assistant", function_call: { name: "other" }, tool_calls: [] },
    { role: "assistant", function_call: { name: "" } },
  ] }],
  ["tools", "gpt-5", { messages: [{ role: "user", content: "x" }], tools: [
    { type: "function", function: { name: "f", description: "d", parameters: { type: "object" }, strict: true } },
    { type: "function", function: { name: "g" } }, { type: "function" }, { type: "web_search" }, "weird",
  ] }],
  ["tool_choice string", "gpt-5", { messages: [], tool_choice: "auto" }],
  ["tool_choice function", "gpt-5", { messages: [], tool_choice: { type: "function", function: { name: "f" } } }],
  ["tool_choice function no name", "gpt-5", { messages: [], tool_choice: { type: "function", function: {} } }],
  ["tool_choice other", "gpt-5", { messages: [], tool_choice: { type: "allowed", mode: "auto" } }],
  ["tool_choice null", "gpt-5", { messages: [], tool_choice: null }],
  ["passthrough", "gpt-5", { messages: [{ role: "user", content: "x" }], previous_response_id: "r", prompt_cache_key: "k", session_id: "s", conversation_id: "c", service_tier: "flex", temperature: 0.2, top_p: 0.9 }],
  ["max tokens priority 1", "gpt-5", { messages: [], max_output_tokens: 1, max_completion_tokens: 2, max_tokens: 3 }],
  ["max tokens priority 2", "gpt-5", { messages: [], max_completion_tokens: 2, max_tokens: 3 }],
  ["max tokens priority 3", "gpt-5", { messages: [], max_tokens: 3 }],
  ["empty input with continuity", "gpt-5", { messages: [], previous_response_id: "r" }],
  ["empty input with conversation", "gpt-5", { messages: [], conversation_id: "c" }],
  ["empty input empty previous", "gpt-5", { messages: [], previous_response_id: "" }],
  ["response_format schema", "gpt-5", { messages: [], response_format: { type: "json_schema", json_schema: { name: "n", schema: { a: 1 }, strict: true } }, verbosity: "HIGH" }],
  ["response_format object + verbosity", "gpt-5", { messages: [], response_format: { type: "json_object" }, verbosity: "low" }],
  ["bad verbosity", "gpt-5", { messages: [], verbosity: "loud" }],
  ["reasoning effort", "gpt-5", { messages: [], reasoning_effort: "high" }],
  ["reasoning effort max native", "gpt-5.6-sol", { messages: [], reasoning_effort: "max" }],
  ["reasoning effort max other", "gpt-4o", { messages: [], reasoning_effort: "max" }],
  ["reasoning effort none", "gpt-5", { messages: [], reasoning_effort: "none" }],
  ["reasoning effort empty", "gpt-5", { messages: [], reasoning_effort: "" }],
  ["reasoning object wins", "gpt-5", { messages: [], reasoning: { effort: "low" }, reasoning_effort: "high" }],
  ["reasoning null", "gpt-5", { messages: [], reasoning: null }],
  ["include kept", "gpt-5", { messages: [], include: ["a"], reasoning_effort: "low" }],
  ["include already encrypted", "gpt-5", { messages: [], include: ["reasoning.encrypted_content"], reasoning_effort: "low" }],
  ["include empty", "gpt-5", { messages: [], include: [] }],
  ["store off ignores body", "gpt-5", { messages: [], store: true }],
  ["store on body", "gpt-5", { messages: [], store: true }, { store: true }],
  ["store on marker wins", "gpt-5", { messages: [], store: false, _omnirouteResponsesStore: true }, { store: true }],
  ["store on none", "gpt-5", { messages: [] }, { store: true }],
  ["model from body for effort", null, { model: "gpt-6-astra", messages: [], reasoning_effort: "max" }],
];
const out = cases.map(([name, model, body, opts = {}]) => {
  const credentials = { providerSpecificData: { openaiStoreEnabled: !!opts.store }, _provider: opts.provider };
  const expected = f(model, structuredClone(body), true, credentials);
  return { name, model, body, store: !!opts.store, provider: opts.provider ?? null, expected: JSON.parse(JSON.stringify(expected)) };
});
writeFileSync(process.argv[3], JSON.stringify(out));
console.log("ok", out.length);
