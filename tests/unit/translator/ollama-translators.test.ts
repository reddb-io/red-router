import { test } from "node:test";
import assert from "node:assert/strict";

// Regression suite for the Ollama native transport ported from the legacy
// RedRouter fork (translators + NDJSON line parsing + registry wiring).

import { bootstrapTranslatorRegistry } from "../../../open-sse/translator/bootstrap.ts";
import {
  getRequestTranslator,
  getResponseTranslator,
} from "../../../open-sse/translator/registry.ts";
import { FORMATS } from "../../../open-sse/translator/formats.ts";
import { openaiToOllamaRequest } from "../../../open-sse/translator/request/openai-to-ollama.ts";
import {
  ollamaToOpenAIResponse,
  ollamaBodyToOpenAI,
} from "../../../open-sse/translator/response/ollama-to-openai.ts";
import { parseNdjsonLine } from "../../../open-sse/utils/streamHelpers.ts";

bootstrapTranslatorRegistry();

test("openai:ollama translator is registered", () => {
  assert.equal(typeof getRequestTranslator(FORMATS.OPENAI, FORMATS.OLLAMA), "function");
  assert.equal(typeof getResponseTranslator(FORMATS.OLLAMA, FORMATS.OPENAI), "function");
});

test("openaiToOllamaRequest flattens content and maps options", () => {
  const body = {
    messages: [
      { role: "system", content: "be terse" },
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,QUJD" },
          },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 128,
    top_p: 0.9,
  };
  const out = openaiToOllamaRequest("llama3", body, true) as Record<string, unknown>;
  assert.equal(out.model, "llama3");
  assert.equal(out.stream, false);
  const options = out.options as Record<string, unknown>;
  assert.equal(options.temperature, 0.2);
  assert.equal(options.num_predict, 128);
  assert.equal(options.top_p, 0.9);
  const messages = out.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, "be terse");
  assert.equal(messages[0].content, "be terse");
  assert.deepEqual(messages[1].images, ["QUJD"]);
  assert.equal(messages[1].content, "what is this?");
});

test("openaiToOllamaRequest maps tool results and assistant tool_calls", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            function: { name: "read_file", arguments: '{"path":"a.txt"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "file body" },
    ],
  };
  const out = openaiToOllamaRequest("m", body, false) as Record<string, unknown>;
  const messages = out.messages as Array<Record<string, unknown>>;
  assert.equal(messages[0].role, "assistant");
  const toolCalls = messages[0].tool_calls as Array<Record<string, unknown>>;
  assert.equal(toolCalls[0].function.name, "read_file");
  assert.deepEqual(toolCalls[0].function.arguments, { path: "a.txt" });
  assert.equal(messages[1].role, "tool");
  assert.equal(messages[1].tool_name, "read_file");
  assert.equal(messages[1].content, "file body");
});

test("ollamaToOpenAIResponse streams content and thinking deltas", () => {
  const state: Record<string, unknown> = { model: "llama3" };
  const c1 = ollamaToOpenAIResponse(
    { model: "llama3", message: { role: "assistant", content: "hel" }, done: false },
    state
  ) as Record<string, unknown>;
  assert.equal(c1.object, "chat.completion.chunk");
  assert.equal((c1.choices as Array<Record<string, unknown>>)[0].delta.content, "hel");

  const c2 = ollamaToOpenAIResponse(
    { model: "llama3", message: { role: "assistant", thinking: "hmm" }, done: false },
    state
  ) as Record<string, unknown>;
  assert.equal((c2.choices as Array<Record<string, unknown>>)[0].delta.reasoning_content, "hmm");

  const done = ollamaToOpenAIResponse(
    { model: "llama3", done: true, prompt_eval_count: 10, eval_count: 25 },
    state
  ) as Record<string, unknown>;
  const doneChoice = (done.choices as Array<Record<string, unknown>>)[0];
  assert.equal(doneChoice.finish_reason, "stop");
  assert.deepEqual(done.usage, {
    prompt_tokens: 10,
    completion_tokens: 25,
    total_tokens: 35,
  });
});

test("ollamaToOpenAIResponse maps tool_calls and forces tool_calls finish", () => {
  const state: Record<string, unknown> = {};
  const chunk = ollamaToOpenAIResponse(
    {
      model: "llama3",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "ls", arguments: {} } }],
      },
      done: false,
    },
    state
  ) as Record<string, unknown>;
  const delta = (chunk.choices as Array<Record<string, unknown>>)[0].delta as Record<
    string,
    unknown
  >;
  const toolCalls = delta.tool_calls as Array<Record<string, unknown>>;
  assert.equal(toolCalls[0].type, "function");
  assert.equal(toolCalls[0].function.name, "ls");
  assert.equal(toolCalls[0].function.arguments, "{}");

  const done = ollamaToOpenAIResponse(
    { model: "llama3", done: true, done_reason: "stop" },
    state
  ) as Record<string, unknown>;
  assert.equal((done.choices as Array<Record<string, unknown>>)[0].finish_reason, "tool_calls");
});

test("ollamaBodyToOpenAI converts a non-streaming body", () => {
  const out = ollamaBodyToOpenAI({
    model: "llama3",
    message: { role: "assistant", content: "hi", thinking: "..." },
    done: true,
    prompt_eval_count: 3,
    eval_count: 4,
  }) as Record<string, unknown>;
  assert.equal(out.object, "chat.completion");
  const message = (out.choices as Array<Record<string, unknown>>)[0].message as Record<
    string,
    unknown
  >;
  assert.equal(message.content, "hi");
  assert.equal(message.reasoning_content, "...");
  assert.deepEqual(out.usage, {
    prompt_tokens: 3,
    completion_tokens: 4,
    total_tokens: 7,
  });
});

test("parseNdjsonLine parses raw JSON lines and rejects SSE lines", () => {
  const parsed = parseNdjsonLine('{"model":"m","done":false}') as Record<string, unknown>;
  assert.equal(parsed.done, false);
  assert.equal(parseNdjsonLine('data: {"done":true}'), null);
  assert.equal(parseNdjsonLine("not json {"), null);
  assert.equal(parseNdjsonLine(""), null);
});
