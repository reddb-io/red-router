import assert from "node:assert/strict";
import test from "node:test";

import { QoderCnExecutor } from "../../open-sse/executors/qoder-cn.ts";
import { clearQoderCnModelCacheForTest } from "../../open-sse/services/qoderCnModels.ts";
import { clearQoderCnPatCacheForTest } from "../../open-sse/services/qoderCnPat.ts";

const frame = (body: unknown) =>
  `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(body) })}\n\n`;

function credential() {
  return {
    accessToken: "dt-device-token",
    providerSpecificData: { userId: "cn-user", machineId: "57c10b0f-4561-423a-a693-9f0348d8b6ba" },
  };
}

test("Qoder CN signs the encoded chat body and keeps the China hosts separate", async () => {
  clearQoderCnModelCacheForTest();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const executor = new QoderCnExecutor(async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/model/list")) {
      return Response.json({ chat: [{ key: "qoder-cn-auto", max_output_tokens: 4096 }] });
    }
    return new Response(
      frame({ id: "cn-1", choices: [{ delta: { content: "你好" } }] }) +
        frame({ choices: [{ delta: { finish_reason: "stop" } }] }) +
        frame({ choices: [], usage: { input_tokens: 2, output_tokens: 3 } }),
      { headers: { "Content-Type": "text/event-stream" } }
    );
  });
  const result = await executor.execute({
    model: "qoder-cn-auto",
    body: { messages: [{ role: "user", content: "hello" }] },
    stream: true,
    credentials: credential(),
  });
  assert.equal(result.response.status, 200);
  const text = await result.response.text();
  assert.match(text, /你好/);
  assert.match(text, /"prompt_tokens":2/);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ url }) => new URL(url).host === "gateway.qoder.com.cn"));
  const chat = requests[1];
  assert.match(chat.url, /Encode=1/);
  const headers = chat.init.headers as Record<string, string>;
  assert.match(headers.Authorization, /^Bearer COSY\./);
  assert.equal(headers["X-Model-Key"], "qoder-cn-auto");
  assert.equal((chat.init as RequestInit & { duplex?: string }).duplex, "half");
  assert.ok(chat.init.body instanceof ReadableStream);
  const wireBody = Buffer.from(await new Response(chat.init.body).arrayBuffer());
  assert.equal(headers["Cosy-Bodylength"], String(wireBody.byteLength));
  assert.doesNotMatch(wireBody.toString("utf8"), /"messages"/);
});

test("Qoder CN resolves a PAT before signing and returns a non-streaming completion", async () => {
  clearQoderCnModelCacheForTest();
  clearQoderCnPatCacheForTest();
  const urls: string[] = [];
  const executor = new QoderCnExecutor(async (url, init) => {
    urls.push(url);
    if (url.endsWith("/jobToken/exchange")) {
      assert.match(String(init.body), /pt-secret/);
      return Response.json({ token: "jt-exchanged" });
    }
    if (url.endsWith("/userinfo")) return Response.json({ id: "pat-user" });
    if (url.endsWith("/model/list")) {
      return Response.json({ chat: [{ key: "qoder-cn-auto", max_output_tokens: 4096 }] });
    }
    return new Response(
      frame({ choices: [{ delta: { content: "answer" } }] }) +
        frame({ choices: [{ delta: { finish_reason: "stop" } }] }) +
        frame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { headers: { "Content-Type": "text/event-stream" } }
    );
  });
  const result = await executor.execute({
    model: "qoder-cn/qoder-cn-auto",
    body: { messages: [{ role: "user", content: "hello" }] },
    stream: false,
    credentials: { apiKey: "pt-secret" },
  });
  assert.equal(result.response.status, 200);
  const body = await result.response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, "answer");
  assert.equal(body.usage.total_tokens, 2);
  assert.equal(urls.length, 4);
  assert.equal(new URL(urls[0]).host, "openapi.qoder.com.cn");
  assert.equal(new URL(urls[3]).host, "gateway.qoder.com.cn");
});

test("Qoder CN does not dispatch chat if the catalog lacks exact model config", async () => {
  clearQoderCnModelCacheForTest();
  let chatRequests = 0;
  const executor = new QoderCnExecutor(async (url) => {
    if (url.endsWith("/model/list")) {
      return Response.json({ chat: [{ key: "different-model" }] });
    }
    chatRequests++;
    throw new Error("unexpected chat request");
  });
  const result = await executor.execute({
    model: "qoder-cn-auto",
    body: { messages: [{ role: "user", content: "hello" }] },
    stream: true,
    credentials: credential(),
  });
  assert.equal(result.response.status, 502);
  assert.equal(chatRequests, 0);
});

test("Qoder CN rejects unsupported documents before sending chat", async () => {
  clearQoderCnModelCacheForTest();
  let uploadsOrChats = 0;
  const executor = new QoderCnExecutor(async (url) => {
    if (url.endsWith("/model/list")) {
      return Response.json({ chat: [{ key: "qoder-cn-auto" }] });
    }
    uploadsOrChats++;
    throw new Error("unexpected request");
  });
  const result = await executor.execute({
    model: "qoder-cn-auto",
    body: { messages: [{ role: "user", content: [{ type: "file", file: {} }] }] },
    stream: true,
    credentials: credential(),
  });
  assert.equal(result.response.status, 400);
  assert.equal(uploadsOrChats, 0);
});
