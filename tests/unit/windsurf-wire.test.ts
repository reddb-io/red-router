import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeWindsurfChunk,
  encodeWindsurfChatRequest,
  frameWindsurfRequest,
  WindsurfFrameDecoder,
} from "../../open-sse/executors/windsurfWire.ts";

const encoder = new TextEncoder();

function field(number: number, bytes: Uint8Array): Uint8Array {
  return Uint8Array.from([(number << 3) | 2, bytes.length, ...bytes]);
}

test("Windsurf request encodes LanguageServerService metadata and message fields", () => {
  const payload = encodeWindsurfChatRequest({
    apiKey: "sk-ws-test",
    modelUid: "gpt-5-4-high",
    messages: [{ role: "user", content: "hello" }],
    sessionId: "session-1",
    cascadeId: "cascade-1",
    ideVersion: "3.14.0",
  });
  const framed = frameWindsurfRequest(payload);
  assert.equal(framed[0], 0);
  assert.equal(new DataView(framed.buffer).getUint32(1, false), payload.length);
  assert.deepEqual(framed.subarray(5), payload);
  assert.ok(Buffer.from(payload).includes(Buffer.from("sk-ws-test")));
  assert.ok(new TextDecoder().decode(payload).includes("gpt-5-4-high"));
  assert.ok(new TextDecoder().decode(payload).includes("hello"));
});

test("Windsurf decoder preserves split frames, usage, and gRPC trailer", () => {
  const content = field(1, field(1, encoder.encode("hello")));
  const done = field(3, field(1, Uint8Array.from([8, 7, 16, 3])));
  const trailer = encoder.encode("grpc-status: 0\r\n");
  const stream = Uint8Array.from([
    ...frameWindsurfRequest(content),
    ...frameWindsurfRequest(done),
    0x80,
    0,
    0,
    0,
    trailer.length,
    ...trailer,
  ]);
  const decoder = new WindsurfFrameDecoder();
  assert.deepEqual(decoder.push(stream.subarray(0, 3)), []);
  const frames = decoder.push(stream.subarray(3));
  assert.deepEqual(frames, [
    { kind: "content", text: "hello" },
    { kind: "done", promptTokens: 7, completionTokens: 3 },
    { kind: "trailer", status: 0, message: "" },
  ]);
  decoder.finish();
});

test("Windsurf wire rejects unsupported tool calls and malformed frames", () => {
  assert.deepEqual(decodeWindsurfChunk(field(2, field(1, encoder.encode("tool")))), {
    kind: "unsupported_tool_call",
  });
  const decoder = new WindsurfFrameDecoder();
  assert.throws(() => decoder.push(Uint8Array.from([0, 0xff, 0xff, 0xff, 0xff])), /too large/);
  assert.throws(() => new WindsurfFrameDecoder().push(Uint8Array.from([1, 0, 0, 0, 0])), /flag/);
  const truncated = new WindsurfFrameDecoder();
  truncated.push(Uint8Array.from([0, 0, 0, 0, 2, 8]));
  assert.throws(() => truncated.finish(), /truncated/);
});

test("Windsurf frame limit applies per frame, not across a combined fetch chunk", () => {
  const first = frameWindsurfRequest(field(9, Uint8Array.from([1, 2, 3, 4])));
  const second = frameWindsurfRequest(field(9, Uint8Array.from([5, 6, 7, 8])));
  const combined = Uint8Array.from([...first, ...second]);
  assert.ok(combined.length > 6);
  const decoder = new WindsurfFrameDecoder(6);
  assert.deepEqual(decoder.push(combined), []);
  decoder.finish();
  assert.throws(() => new WindsurfFrameDecoder(16 * 1024 * 1024 + 1), /limit/);
});
