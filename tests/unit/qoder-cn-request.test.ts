import assert from "node:assert/strict";
import test from "node:test";

import { buildQoderCnRequest } from "../../open-sse/services/qoderCnRequest.ts";

const modelConfig = {
  key: "qmodel_latest",
  max_input_tokens: 180_000,
  max_output_tokens: 8_192,
  is_reasoning: true,
  context_config: [
    { name: "200K", tokenCount: 200_000 },
    { name: "400K", tokenCount: 400_000 },
  ],
};

test("Qoder CN maps text and tools while preserving the exact live model config", () => {
  const tool = { type: "function", function: { name: "lookup", parameters: { type: "object" } } };
  const { payload, plaintext } = buildQoderCnRequest(
    "qmodel_latest",
    {
      messages: [
        { role: "system", content: "Be concise" },
        { role: "user", content: [{ type: "text", text: "Olá" }] },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-1", function: { name: "lookup" } }],
        },
        { role: "tool", tool_call_id: "call-1", content: "Found" },
      ],
      tools: [tool],
      max_tokens: 1_024,
    },
    modelConfig,
    "cn-user"
  );
  assert.equal(payload.system, "Be concise");
  assert.equal((payload.messages as Array<{ role: string; content: string }>)[0].content, "Olá");
  assert.equal((payload.messages as Array<{ role: string }>)[0].role, "user");
  assert.equal((payload.messages as Array<{ role: string }>)[2].role, "tool");
  assert.deepEqual(payload.tools, [tool]);
  assert.deepEqual(payload.model_config, modelConfig);
  assert.equal((payload.parameters as { max_tokens: number }).max_tokens, 1_024);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext)), payload);
});

test("Qoder CN request preserves uploaded image URLs and rejects unported attachments", () => {
  const image = { type: "image_url", image_url: { url: "https://oss.qoder.com.cn/image" } };
  const withImage = buildQoderCnRequest(
    "qmodel_latest",
    { messages: [{ role: "user", content: [{ type: "text", text: "See" }, image] }] },
    modelConfig,
    "cn-user"
  ).payload;
  assert.deepEqual((withImage.messages as Array<{ content: unknown }>)[0].content, [
    { type: "text", text: "See" },
    image,
  ]);
  assert.throws(
    () =>
      buildQoderCnRequest(
        "different",
        { messages: [{ role: "user", content: "hi" }] },
        modelConfig,
        "cn-user"
      ),
    /invalid/
  );
  assert.throws(
    () =>
      buildQoderCnRequest(
        "qmodel_latest",
        {
          messages: [
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }],
            },
          ],
        },
        modelConfig,
        "cn-user"
      ),
    /invalid image URL/
  );
  assert.throws(
    () =>
      buildQoderCnRequest(
        "qmodel_latest",
        { messages: [{ role: "user", content: [{ type: "file", file: {} }] }] },
        modelConfig,
        "cn-user"
      ),
    /unsupported attachment/
  );
});

test("Qoder CN escalates the context tier only when the prompt outgrows the current limit", () => {
  const large = buildQoderCnRequest(
    "qmodel_latest",
    { messages: [{ role: "user", content: "abcd".repeat(190_000) }] },
    modelConfig,
    "cn-user"
  ).payload;
  assert.equal((large.parameters as { context_length: number }).context_length, 400_000);
  assert.equal((large.model_config as { max_input_tokens: number }).max_input_tokens, 400_000);
  const context = large.chat_context as {
    extra: { ideModelConfigOverride: { max_input_tokens: number } };
  };
  assert.equal(context.extra.ideModelConfigOverride.max_input_tokens, 400_000);
});

test("Qoder CN record identity is stable for equivalent user input", () => {
  const input = { messages: [{ role: "user", content: "same input" }] };
  const first = buildQoderCnRequest("qmodel_latest", input, modelConfig, "cn-user").payload;
  const second = buildQoderCnRequest("qmodel_latest", input, modelConfig, "cn-user").payload;
  assert.equal(first.chat_record_id, second.chat_record_id);
  assert.equal(first.session_id, second.session_id);
  assert.notEqual(first.request_id, second.request_id);
});
