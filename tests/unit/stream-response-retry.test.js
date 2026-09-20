import { describe, expect, it, vi } from "vitest";
import { prepareStreamingResponse } from "../../open-sse/handlers/chatCore/streamResponse.js";

const encoder = new TextEncoder();

function response(chunks, init = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: init.status || 200,
    headers: { "content-type": init.contentType || "text/event-stream", ...(init.headers || {}) },
  });
}

async function text(result) {
  return result.response.text();
}

describe("prepareStreamingResponse", () => {
  it("retries an empty response before exposing the first byte", async () => {
    const execute = vi.fn(async () => ({ response: response(["data: ok\n\n"]) }));
    const result = await prepareStreamingResponse({
      initialResult: { response: response([]) }, execute, executor: {}, targetFormat: "openai",
      provider: "test", model: "model", maxRetries: 3,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(await text(result)).toBe("data: ok\n\n");
  });

  it("returns a 502 error after retry exhaustion", async () => {
    const execute = vi.fn(async () => ({ response: response([]) }));
    const result = await prepareStreamingResponse({
      initialResult: { response: response([]) }, execute, executor: {}, targetFormat: "openai",
      provider: "test", model: "model", maxRetries: 2,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.error).toMatchObject({ statusCode: 502, message: expect.stringContaining("first byte") });
  });

  it("does not retry HTTP errors and retains Retry-After metadata", async () => {
    const execute = vi.fn();
    const result = await prepareStreamingResponse({
      initialResult: { response: response([JSON.stringify({ error: { message: "slow down" } })], { status: 429, contentType: "application/json", headers: { "retry-after": "5" } }) },
      execute, executor: {}, targetFormat: "openai", provider: "test", model: "model",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.error.statusCode).toBe(429);
    expect(result.error.resetsAtMs).toBeGreaterThan(Date.now());
  });

  it("rejects a JSON error envelope returned by a reconnect", async () => {
    const execute = vi.fn(async () => ({ response: response([JSON.stringify({ error: { message: "provider failed" } })], { contentType: "application/json" }) }));
    const result = await prepareStreamingResponse({
      initialResult: { response: response([]) }, execute, executor: {}, targetFormat: "openai",
      provider: "test", model: "model", maxRetries: 1,
    });
    expect(result.error).toMatchObject({ statusCode: 502, message: "provider failed" });
  });

  it("rejects an invalid reconnect content type", async () => {
    const execute = vi.fn(async () => ({ response: response(["<html><title>Edge failed</title></html>"], { contentType: "text/html" }) }));
    const result = await prepareStreamingResponse({
      initialResult: { response: response([]) }, execute, executor: {}, targetFormat: "openai",
      provider: "test", model: "model", maxRetries: 1,
    });
    expect(result.error).toMatchObject({ statusCode: 502, message: "Edge failed" });
  });

  it("preserves every byte and never retries after the first chunk", async () => {
    const execute = vi.fn();
    const result = await prepareStreamingResponse({
      initialResult: { response: response(["first", "second"]) }, execute, executor: {}, targetFormat: "openai",
      provider: "test", model: "model", maxRetries: 3,
    });
    expect(await text(result)).toBe("firstsecond");
    expect(execute).not.toHaveBeenCalled();
  });

  it("honors an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(prepareStreamingResponse({
      initialResult: { response: response([]) }, execute: vi.fn(), executor: {}, targetFormat: "openai",
      provider: "test", model: "model", signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});
