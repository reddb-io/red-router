import assert from "node:assert/strict";
import test from "node:test";

import { REGISTRY } from "../../open-sse/config/providerRegistry.ts";
import { resolveWindsurfModelUid } from "../../open-sse/config/windsurfModels.ts";
import { getExecutor } from "../../open-sse/executors/index.ts";
import { WindsurfExecutor } from "../../open-sse/executors/windsurf.ts";
import { frameWindsurfRequest } from "../../open-sse/executors/windsurfWire.ts";
import { resolveProviderId } from "../../src/shared/constants/providers.ts";
import { validateWindsurfProvider } from "../../src/lib/providers/validation/windsurf.ts";

const encoder = new TextEncoder();

function field(number: number, bytes: Uint8Array): Uint8Array {
  return Uint8Array.from([(number << 3) | 2, bytes.length, ...bytes]);
}

test("Windsurf has its own catalog, executor and alias, not Devin Desktop", async () => {
  assert.equal(resolveProviderId("ws"), "windsurf");
  assert.equal(REGISTRY.windsurf.executor, "windsurf");
  assert.equal(REGISTRY.windsurf.forceStream, true);
  assert.equal(resolveWindsurfModelUid("gpt-5.4-high"), "gpt-5-4-high");
  assert.equal(resolveWindsurfModelUid("claude-sonnet-4.5"), "MODEL_PRIVATE_2");
  assert.equal(resolveWindsurfModelUid("unknown"), null);
  assert.equal((await getExecutor("windsurf")).provider, "windsurf");
  assert.equal((await getExecutor("ws")).provider, "windsurf");
  assert.notEqual(REGISTRY.windsurf.baseUrl, REGISTRY["devin-desktop"].baseUrl);
});

test("Windsurf direct key uses LanguageServerService and translates bounded frames to SSE", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const content = field(1, field(1, encoder.encode("hello")));
  const trailer = encoder.encode("grpc-status: 0\r\n");
  const responseBody = Uint8Array.from([
    ...frameWindsurfRequest(content),
    0x80,
    0,
    0,
    0,
    trailer.length,
    ...trailer,
  ]);
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(responseBody, {
      status: 200,
      headers: { "Content-Type": "application/grpc-web+proto" },
    });
  };
  try {
    const result = await new WindsurfExecutor().execute({
      model: "gpt-5.4-high",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "sk-ws-test" },
    });
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://server.codeium.com/exa.language_server_pb.LanguageServerService/GetChatMessage"
    );
    assert.equal(
      (calls[0].init.headers as Record<string, string>).Authorization,
      "Bearer sk-ws-test"
    );
    assert.ok(Buffer.from(calls[0].init.body as ArrayBuffer).includes(Buffer.from("gpt-5-4-high")));
    assert.equal(result.response.status, 200);
    const text = await result.response.text();
    assert.match(text, /"content":"hello"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(
      result.transformedBody,
      null,
      "protobuf carries the API key and must not be logged"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Windsurf rejects unsupported inputs before a billable upstream request", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fetch must not be called");
  };
  try {
    const executor = new WindsurfExecutor();
    for (const body of [
      { messages: [{ role: "user", content: "hi" }], tools: [{ type: "function" }] },
      { messages: [{ role: "user", content: [{ type: "image_url", image_url: "x" }] }] },
    ]) {
      const result = await executor.execute({
        model: "gpt-5.4-high",
        body,
        stream: true,
        credentials: { apiKey: "sk-ws-test" },
      });
      assert.equal(result.response.status, 400);
    }
    const missingKey = await executor.execute({
      model: "gpt-5.4-high",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: {},
    });
    assert.equal(missingKey.response.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Windsurf sanitizes gRPC trailer errors inside SSE", async () => {
  const originalFetch = globalThis.fetch;
  const trailer = encoder.encode("grpc-status: 13\r\ngrpc-message: at /srv/private/secret.ts\r\n");
  globalThis.fetch = async () =>
    new Response(Uint8Array.from([0x80, 0, 0, 0, trailer.length, ...trailer]));
  try {
    const result = await new WindsurfExecutor().execute({
      model: "gpt-5.4-high",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "sk-ws-test" },
    });
    const text = await result.response.text();
    assert.match(text, /"error":/);
    assert.doesNotMatch(text, /\/srv\/private\/secret\.ts/);
    assert.doesNotMatch(text, /"finish_reason":"stop"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Windsurf does not misreport unsupported tool-call chunks as success", async () => {
  const originalFetch = globalThis.fetch;
  const toolChunk = field(2, field(1, encoder.encode("tool")));
  globalThis.fetch = async () => new Response(frameWindsurfRequest(toolChunk));
  try {
    const result = await new WindsurfExecutor().execute({
      model: "gpt-5.4-high",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "sk-ws-test" },
    });
    const text = await result.response.text();
    assert.match(text, /"error":/);
    assert.doesNotMatch(text, /"finish_reason":"stop"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Windsurf credential validation requires a completed chat probe", async () => {
  const originalFetch = globalThis.fetch;
  const trailer = encoder.encode("grpc-status: 0\r\n");
  const goodBody = Uint8Array.from([
    ...frameWindsurfRequest(field(1, field(1, encoder.encode("OK")))),
    0x80,
    0,
    0,
    0,
    trailer.length,
    ...trailer,
  ]);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(goodBody);
  };
  try {
    assert.deepEqual(await validateWindsurfProvider({ apiKey: "sk-ws-test" }), {
      valid: true,
      error: null,
    });
    assert.equal(calls, 1, "one explicit provider chat probe may consume credits");
    assert.equal((await validateWindsurfProvider({ apiKey: "" })).valid, false);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
