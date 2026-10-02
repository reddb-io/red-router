import assert from "node:assert/strict";
import test from "node:test";

import { DefaultExecutor } from "../../../open-sse/executors/default.ts";
import { resolveFetchStartTimeout } from "../../../open-sse/utils/fetchStartTimeoutPolicy.ts";

test("Claude dispatch allows headers after the generic streaming cap", async (context) => {
  const originalSetTimeout = globalThis.setTimeout;
  const deadlines: number[] = [];
  context.mock.method(
    globalThis,
    "setTimeout",
    (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      deadlines.push(delay ?? 0);
      // Compress virtual deadlines, while keeping the upstream between 110s and 600s.
      const scaled = delay === 110_000 ? 1 : delay === 600_000 ? 100 : delay;
      return originalSetTimeout(callback, scaled, ...args);
    }
  );
  context.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    await new Promise<void>((resolve, reject) => {
      const timer = originalSetTimeout(resolve, 20);
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(options.signal?.reason);
        },
        { once: true }
      );
    });
    return new Response("event: message_start\ndata: {}\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const executor = new DefaultExecutor("claude");
  const result = await executor.execute({
    model: "claude-sonnet-5",
    stream: true,
    body: {
      model: "claude-sonnet-5",
      stream: true,
      max_tokens: 1024,
      messages: [{ role: "user", content: "Reply only OK." }],
    },
    credentials: { accessToken: "sk-ant-oat01-test-only" },
    skipUpstreamRetry: true,
  });
  assert.equal(result.response.status, 200);
  assert.ok(deadlines.includes(600_000));
  assert.ok(!deadlines.includes(110_000));
  await result.response.body?.cancel();
});

test("an operator connection deadline wins over streaming defaults and disabled provider timeouts", () => {
  for (const stream of [true, false]) {
    for (const baseTimeoutMs of [0, 60_000, 600_000]) {
      assert.equal(
        resolveFetchStartTimeout({ baseTimeoutMs, stream, connectionTimeoutMs: 180_000 }).timeoutMs,
        180_000
      );
    }
  }
  for (const connectionTimeoutMs of [0, -1, Infinity, NaN, "180000", 86_400_001]) {
    assert.equal(
      resolveFetchStartTimeout({ baseTimeoutMs: 600_000, stream: true, connectionTimeoutMs })
        .timeoutMs,
      110_000
    );
  }
});

test("Claude dispatch forwards the active connection's explicit response-start deadline", async (context) => {
  const originalSetTimeout = globalThis.setTimeout;
  const deadlines: number[] = [];
  context.mock.method(
    globalThis,
    "setTimeout",
    (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      deadlines.push(delay ?? 0);
      return originalSetTimeout(callback, delay, ...args);
    }
  );
  context.mock.method(globalThis, "fetch", async () => {
    return new Response("event: message_start\ndata: {}\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const executor = new DefaultExecutor("claude");
  const result = await executor.execute({
    model: "claude-sonnet-5",
    stream: true,
    body: {
      model: "claude-sonnet-5",
      stream: true,
      max_tokens: 1024,
      messages: [{ role: "user", content: "Reply only OK." }],
    },
    credentials: {
      accessToken: "sk-ant-oat01-test-only",
      providerSpecificData: { timeoutMs: 180_000 },
    },
    skipUpstreamRetry: true,
  });
  assert.equal(result.response.status, 200);
  assert.ok(deadlines.includes(180_000));
  assert.ok(!deadlines.includes(600_000));
  assert.ok(!deadlines.includes(110_000));
  await result.response.body?.cancel();
});
