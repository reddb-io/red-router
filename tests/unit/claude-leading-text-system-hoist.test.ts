import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hoistLeadingTextSystemMessages,
  relocateDirectiveOnlyMessages,
} from "../../open-sse/handlers/chatCore/claudeSystemRole.ts";

// Output Styles injects a text system message at messages[0]. Anthropic
// rejects it on the mid-conversation-system passthrough unless it is top-level.
test("hoists a leading text system message without changing later turns", () => {
  const payload: Record<string, unknown> = {
    system: [{ type: "text", text: "You are Claude." }],
    output_config: { effort: "medium" },
    messages: [
      { role: "system", content: "[OmniRoute Output Styles]\nRespond terse." },
      { role: "user", content: "Reply exactly: MIDCONV_TOPLEVEL_OK" },
    ],
  };

  hoistLeadingTextSystemMessages(payload);

  assert.deepEqual(payload.system, [
    { type: "text", text: "You are Claude." },
    { type: "text", text: "[OmniRoute Output Styles]\nRespond terse." },
  ]);
  assert.deepEqual(
    (payload.messages as Array<{ role: string }>).map((message) => message.role),
    ["user"]
  );
  assert.deepEqual(payload.output_config, { effort: "medium" });
});

test("preserves mid-conversation system turns and converts a string top-level system", () => {
  const payload: Record<string, unknown> = {
    system: "base",
    messages: [
      { role: "system", content: [{ type: "text", text: "style" }] },
      { role: "user", content: "hello" },
      { role: "system", content: "mid-conversation context" },
      { role: "assistant", content: "hi" },
    ],
  };

  hoistLeadingTextSystemMessages(payload);

  assert.deepEqual(payload.system, [
    { type: "text", text: "base" },
    { type: "text", text: "style" },
  ]);
  assert.deepEqual(
    (payload.messages as Array<{ role: string }>).map((message) => message.role),
    ["user", "system", "assistant"]
  );
});

test("leaves directive-only messages for relocation", () => {
  const payload: Record<string, unknown> = {
    messages: [
      { role: "system", content: [], output_config: { effort: "high" } },
      { role: "system", content: "style" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ],
  };

  hoistLeadingTextSystemMessages(payload);
  assert.deepEqual(payload.system, [{ type: "text", text: "style" }]);
  relocateDirectiveOnlyMessages(payload);
  const messages = payload.messages as Array<Record<string, unknown>>;
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "system", "assistant"]
  );
  assert.deepEqual(messages[1].output_config, { effort: "high" });
});

test("does not change a normal user-first request", () => {
  const payload: Record<string, unknown> = {
    system: "base",
    messages: [{ role: "user", content: "hello" }],
  };

  hoistLeadingTextSystemMessages(payload);

  assert.equal(payload.system, "base");
  assert.deepEqual(payload.messages, [{ role: "user", content: "hello" }]);
});

test("preserves cache metadata on text blocks and does not drop mixed system content", () => {
  const cacheControl = { type: "ephemeral", ttl: "1h" };
  const payload: Record<string, unknown> = {
    messages: [
      {
        role: "system",
        content: [{ type: "text", text: "cached style", cache_control: cacheControl }],
      },
      {
        role: "system",
        content: [
          { type: "text", text: "keep together" },
          { type: "image", source: { type: "url", url: "https://example.invalid/image.png" } },
        ],
      },
      { role: "system", content: "later style" },
      { role: "user", content: "hello" },
    ],
  };

  hoistLeadingTextSystemMessages(payload);

  assert.deepEqual(payload.system, [
    { type: "text", text: "cached style", cache_control: cacheControl },
  ]);
  assert.deepEqual(
    (payload.messages as Array<{ role: string }>).map((message) => message.role),
    ["system", "system", "user"]
  );
  assert.deepEqual((payload.messages as Array<{ content: unknown }>)[0].content, [
    { type: "text", text: "keep together" },
    { type: "image", source: { type: "url", url: "https://example.invalid/image.png" } },
  ]);
});
