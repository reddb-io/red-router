import assert from "node:assert/strict";
import test from "node:test";

import { forwardSystemOne, resolveSystemOneTarget } from "../../open-sse/handlers/systemOneCore.ts";
import { systemOneBodySchema } from "../../src/sse/handlers/systemOne.ts";

test("System One accepts native question shapes and retains extension fields", () => {
  const parsed = systemOneBodySchema.parse({
    model: "typesafe-ai/jev-latest",
    state: 0,
    questions: { future: { type: "future-decision", payload: [1, 2] } },
    metadata: { caller: "agent" },
  });
  assert.equal(parsed.state, 0);
  assert.deepEqual(parsed.questions.future, { type: "future-decision", payload: [1, 2] });
  assert.deepEqual(parsed.metadata, { caller: "agent" });
  assert.equal(systemOneBodySchema.safeParse({ questions: {} }).success, false);
  assert.equal(systemOneBodySchema.safeParse({ state: null, questions: {} }).success, false);
  assert.equal(systemOneBodySchema.safeParse({ state: 1, questions: [] }).success, false);
});

test("System One ids resolve to provider-specific decisions routes", () => {
  assert.equal(resolveSystemOneTarget()?.url, "https://api.typesafe.ai/v1/systemone");
  assert.deepEqual(
    resolveSystemOneTarget("opencode-zen/jev-1.13-free") && {
      provider: resolveSystemOneTarget("opencode-zen/jev-1.13-free")?.provider,
      model: resolveSystemOneTarget("opencode-zen/jev-1.13-free")?.model,
    },
    { provider: "opencode-zen", model: "jev-1.13-free" }
  );
  assert.equal(resolveSystemOneTarget("opencode/jev-unknown"), null);
  assert.equal(
    resolveSystemOneTarget("openrouter/typesafe/jev-1.13")?.url,
    "https://openrouter.ai/api/v1/systemone"
  );
  assert.equal(resolveSystemOneTarget("typesafe-ai/jev-1.13")?.model, "jev-1.13.0");
  assert.deepEqual(
    {
      provider: resolveSystemOneTarget("opencode/jev-1.13-free")?.provider,
      model: resolveSystemOneTarget("opencode/jev-1.13-free")?.model,
    },
    { provider: "opencode", model: "jev-1.13-free" }
  );
  assert.equal(resolveSystemOneTarget("openrouter/not-jev"), null);
});

test("System One forwards native state and questions without chat translation", async () => {
  const target = resolveSystemOneTarget("opencode-zen/jev-1.13-free");
  assert.ok(target);
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  const result = await forwardSystemOne(
    target,
    "secret",
    {
      model: "typesafe-ai/jev-1.13.0",
      state: "Classify this",
      questions: { ready: { type: "noul", instructions: "Ready?" } },
      metadata: { caller: "agent" },
    },
    {
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
        });
        return Response.json({ model: "jev-1.13-free", answers: { ready: { noul: 1 } } });
      },
    }
  );
  assert.equal(result.response.status, 200);
  assert.equal(calls[0].url, "https://opencode.ai/zen/v1/systemone");
  assert.deepEqual(calls[0].body, {
    model: "jev-1.13-free",
    state: "Classify this",
    questions: { ready: { type: "noul", instructions: "Ready?" } },
    metadata: { caller: "agent" },
  });
  assert.equal(calls[0].headers.get("x-opencode-client"), "desktop");
  assert.match(calls[0].headers.get("x-opencode-session") ?? "", /^ses_/);
});

test("System One preserves retry status without leaking upstream stack traces", async () => {
  const target = resolveSystemOneTarget();
  assert.ok(target);
  const result = await forwardSystemOne(
    target,
    "secret",
    { state: "x", questions: { q: {} } },
    {
      fetchImpl: async () =>
        new Response('{"error":{"message":"at /private/secret.ts:9"}}', {
          status: 429,
          headers: { "retry-after": "7" },
        }),
    }
  );
  assert.equal(result.response.status, 429);
  assert.equal(result.response.headers.get("retry-after"), "7");
  assert.ok(!(await result.response.text()).includes("/private/secret.ts"));
});

test("System One bounds successful upstream JSON before parsing it", async () => {
  const target = resolveSystemOneTarget();
  assert.ok(target);
  let cancelled = false;
  const result = await forwardSystemOne(
    target,
    "secret",
    { state: "x", questions: { q: {} } },
    {
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 }
        ),
    }
  );
  assert.equal(result.response.status, 502);
  assert.equal(cancelled, true);
  assert.equal(result.usage, null);
});

test("OpenCode Free System One sends client identity without a bearer token", async () => {
  const target = resolveSystemOneTarget("opencode/jev-1.13-free");
  assert.ok(target);
  const result = await forwardSystemOne(
    target,
    null,
    { state: "Classify", questions: { tier: { type: "choice" } } },
    {
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), null);
        assert.equal(headers.get("x-opencode-client"), "desktop");
        assert.match(headers.get("x-opencode-session") ?? "", /^ses_/);
        return Response.json({ answers: { tier: { choice: "SIMPLE", confidence: 1 } } });
      },
    }
  );
  assert.equal(result.response.status, 200);
});

test("Only OpenCode Free may use System One without credentials", async () => {
  const target = resolveSystemOneTarget("typesafe-ai/jev-latest");
  assert.ok(target);
  let called = false;
  const result = await forwardSystemOne(
    target,
    null,
    { state: "x", questions: { ready: { type: "noul" } } },
    {
      fetchImpl: async () => {
        called = true;
        return Response.json({ answers: {} });
      },
    }
  );
  assert.equal(result.response.status, 401);
  assert.equal(called, false);
});
