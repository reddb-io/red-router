import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeQoderCnUsage, wrapQoderCnSse } from "../../open-sse/services/qoderCnSse.ts";

const encoder = new TextEncoder();
const frame = (status: number, body: unknown) =>
  `data: ${JSON.stringify({ statusCodeValue: status, body: JSON.stringify(body) })}\n\n`;

function upstream(chunks: string[], keepOpen = false) {
  let cancelled = false;
  return {
    response: new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          if (!keepOpen) controller.close();
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    ),
    wasCancelled: () => cancelled,
  };
}

function events(body: string): Array<Record<string, unknown> | "[DONE]"> {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => {
      const text = line.slice(5).trim();
      return text === "[DONE]" ? text : JSON.parse(text);
    });
}

test("Qoder CN surfaces a fragmented first-frame billing failure as HTTP 403", async () => {
  const source = ": heartbeat\r\n\r\n" + frame(403, { code: "112", message: "private token" });
  const { response, wasCancelled } = upstream([source.slice(0, 17), source.slice(17)], true);
  const wrapped = await wrapQoderCnSse(response, "qoder-cn/auto");
  assert.equal(wrapped.status, 403);
  const body = await wrapped.text();
  assert.match(body, /quota is unavailable/);
  assert.doesNotMatch(body, /private token/);
  assert.equal(wasCancelled(), true);
});

test("Qoder CN coalesces finish and late usage without waiting for keepalive EOF", async () => {
  const source =
    frame(200, { id: "chunk-1", choices: [{ delta: { content: "hello" } }] }) +
    frame(200, { choices: [{ delta: { finish_reason: "stop" } }] }) +
    frame(200, {
      choices: [],
      usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 5 },
    });
  const { response, wasCancelled } = upstream([source], true);
  const wrapped = await wrapQoderCnSse(response, "qoder-cn/auto");
  assert.equal(wrapped.status, 200);
  const decoded = events(await wrapped.text());
  assert.equal(decoded.length, 3);
  assert.equal(
    (decoded[0] as { choices: Array<{ delta: { content: string } }> }).choices[0].delta.content,
    "hello"
  );
  const terminal = decoded[1] as {
    choices: Array<{ finish_reason: string }>;
    usage: Record<string, unknown>;
  };
  assert.equal(terminal.choices[0].finish_reason, "stop");
  assert.equal(terminal.usage.prompt_tokens, 12);
  assert.deepEqual(terminal.usage.prompt_tokens_details, { cached_tokens: 5 });
  assert.equal(decoded[2], "[DONE]");
  assert.equal(wasCancelled(), true);
});

test("Qoder CN late errors remain structured SSE errors, not assistant text", async () => {
  const source =
    frame(200, { choices: [{ delta: { content: "partial" } }] }) +
    frame(500, { message: "secret at /srv/private" });
  const { response } = upstream([source], true);
  const wrapped = await wrapQoderCnSse(response, "qoder-cn/auto");
  const body = await wrapped.text();
  const decoded = events(body);
  assert.equal(
    (decoded[0] as { choices: Array<{ delta: { content: string } }> }).choices[0].delta.content,
    "partial"
  );
  assert.ok("error" in (decoded[1] as Record<string, unknown>));
  assert.equal(decoded[2], "[DONE]");
  assert.doesNotMatch(body, /secret at \/srv\/private|qoder error/);
});

test("Qoder CN rejects malformed first frames and raw upstream errors", async () => {
  const malformed = await wrapQoderCnSse(
    upstream(["data: not-json\n\n"]).response,
    "qoder-cn/auto"
  );
  assert.equal(malformed.status, 502);
  const response = new Response("token at /srv/private", { status: 401 });
  const rejected = await wrapQoderCnSse(response, "qoder-cn/auto");
  assert.equal(rejected.status, 401);
  assert.doesNotMatch(await rejected.text(), /token at \/srv\/private/);
});

test("Qoder CN rejects an invalid upstream status without exposing NaN", async () => {
  const wrapped = await wrapQoderCnSse(
    upstream(['data: {"statusCodeValue":"not-a-status","body":"private"}\n\n']).response,
    "qoder-cn/auto"
  );
  assert.equal(wrapped.status, 502);
  const body = await wrapped.text();
  assert.match(body, /invalid upstream status/);
  assert.doesNotMatch(body, /NaN|private/);
});

test("Qoder CN accepts a final SSE data line without a trailing newline", async () => {
  const source =
    frame(200, { choices: [{ delta: { content: "complete" } }] }) +
    frame(200, { choices: [{ delta: { finish_reason: "stop" } }] }).trimEnd();
  const wrapped = await wrapQoderCnSse(upstream([source]).response, "qoder-cn/auto");
  assert.equal(wrapped.status, 200);
  const decoded = events(await wrapped.text());
  assert.equal(decoded.length, 3);
  assert.equal(decoded[2], "[DONE]");
});

test("Qoder CN enforces the first SSE line limit by bytes", async () => {
  const oversized = `: ${"é".repeat(600_000)}\n`;
  const wrapped = await wrapQoderCnSse(
    upstream([oversized + frame(200, { choices: [{ delta: { content: "hidden" } }] })]).response,
    "qoder-cn/auto"
  );
  assert.equal(wrapped.status, 502);
  assert.doesNotMatch(await wrapped.text(), /hidden/);
});

test("Qoder CN normalizes usage detail fields for downstream accounting", () => {
  assert.deepEqual(
    canonicalizeQoderCnUsage({
      prompt_tokens: 10,
      completion_tokens: 2,
      cached_tokens: 4,
      cache_creation_input_tokens: 3,
      reasoning_tokens: 1,
    }),
    {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      cached_tokens: 4,
      prompt_tokens_details: { cached_tokens: 4, cache_creation_tokens: 3 },
      reasoning_tokens: 1,
      completion_tokens_details: { reasoning_tokens: 1 },
    }
  );
});
