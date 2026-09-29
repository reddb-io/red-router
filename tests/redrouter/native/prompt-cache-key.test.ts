import assert from "node:assert/strict";
import test from "node:test";

process.env.DATA_DIR ||= `${process.env.TMPDIR || "/tmp"}/redrouter-cache-key-${process.pid}`;

const { sessionPromptCacheKey, injectPromptCacheKey } =
  await import("../../../open-sse/handlers/chatCore/upstreamBody.ts");

test("a session gets one stable cache key per key holder, and different sessions differ", () => {
  const a = sessionPromptCacheKey("key-1", "session-a");
  assert.match(a ?? "", /^rr-[0-9a-f]{24}$/);
  assert.equal(a, sessionPromptCacheKey("key-1", "session-a"));
  assert.notEqual(a, sessionPromptCacheKey("key-1", "session-b"));
  assert.notEqual(a, sessionPromptCacheKey("key-2", "session-a"));
  assert.equal(sessionPromptCacheKey("key-1", ""), null);
  assert.equal(sessionPromptCacheKey("key-1", null), null);
});

test("Codex and OpenAI Responses requests carry the session's cache key", async () => {
  const key = sessionPromptCacheKey("key-1", "session-a");
  for (const provider of ["codex", "openai"]) {
    const sent = await injectPromptCacheKey(
      { model: "gpt-5", input: [] },
      provider,
      "openai-responses",
      null,
      key
    );
    assert.equal(sent.prompt_cache_key, key, provider);
  }
  // A client's own key is never replaced, and other providers are left alone.
  const own = await injectPromptCacheKey(
    { input: [], prompt_cache_key: "mine" },
    "codex",
    "openai-responses",
    null,
    key
  );
  assert.equal(own.prompt_cache_key, "mine");
  const other = await injectPromptCacheKey({ input: [] }, "groq", "openai-responses", null, key);
  assert.equal(other.prompt_cache_key, undefined);
});

test("Chat Completions to a caching provider uses the session key instead of the shared prefix hash", async () => {
  const messages = [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "hi" },
  ];
  const key = sessionPromptCacheKey("key-1", "session-a");
  const withSession = await injectPromptCacheKey(
    { model: "gpt-5", messages },
    "openai",
    "openai",
    null,
    key
  );
  assert.equal(withSession.prompt_cache_key, key);
  const withoutSession = await injectPromptCacheKey(
    { model: "gpt-5", messages },
    "openai",
    "openai",
    null,
    null
  );
  assert.match(String(withoutSession.prompt_cache_key ?? "omni-"), /^(omni|rr)-/);
  assert.notEqual(withoutSession.prompt_cache_key, key);
  // Providers that reject the field never get it.
  const nvidia = await injectPromptCacheKey(
    { model: "x", messages },
    "nvidia",
    "openai",
    null,
    key
  );
  assert.equal(nvidia.prompt_cache_key, undefined);
});
