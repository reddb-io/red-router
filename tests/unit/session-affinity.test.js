// Session affinity: x-session-affinity / x-parent-session-id are session keys, a
// combo keeps the member that served a session, and OpenAI upstreams get the
// session as prompt_cache_key.
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  resolveSessionId,
  resolveAffinityKey,
  promptCacheKeyFor,
  SESSION_HEADERS,
  AFFINITY_HEADERS,
  clearSessionStore,
} from "../../open-sse/utils/sessionManager.js";
import {
  getSessionMember,
  rememberSessionMember,
  forgetSessionMember,
  preferSessionMember,
  resetSessionAffinity,
  sessionAffinitySize,
} from "../../open-sse/services/sessionAffinity.js";
import { handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";
import { applyPromptCacheKey } from "../../open-sse/handlers/chatCore.js";
import { SESSION_AFFINITY_CONFIG } from "../../open-sse/config/runtimeConfig.js";

const log = { info() {}, warn() {}, debug() {} };
const ok = (model) => new Response(JSON.stringify({ model }), { status: 200, headers: { "Content-Type": "application/json" } });
const rateLimited = () => new Response(JSON.stringify({ error: { message: "rate limited" } }), {
  status: 429,
  headers: { "Content-Type": "application/json" },
});

beforeEach(() => {
  resetSessionAffinity();
  resetComboRotation();
  clearSessionStore();
});

describe("session headers", () => {
  it("reads the affinity headers right after x-session-id", () => {
    const at = (name) => SESSION_HEADERS.indexOf(name);
    expect(at("x-session-affinity")).toBe(at("x-session-id") + 1);
    expect(at("x-parent-session-id")).toBe(at("x-session-id") + 2);
    expect(AFFINITY_HEADERS).toEqual(["x-parent-session-id", "x-session-affinity"]);
  });

  it("uses x-session-affinity, then x-parent-session-id, as the session id", () => {
    expect(resolveSessionId({ headers: { "x-session-affinity": "ses_own", "session-id": "other" } })).toBe("ses_own");
    expect(resolveSessionId({ headers: { "x-session-id": "first", "x-session-affinity": "ses_own" } })).toBe("first");
    expect(resolveSessionId({ headers: { "x-parent-session-id": "ses_parent", "session-id": "other" } })).toBe("ses_parent");
    expect(resolveSessionId({ headers: { "x-parent-session-id": "ses_parent", "x-session-affinity": "ses_own" } })).toBe("ses_own");
  });

  it("groups a subagent with its parent for affinity", () => {
    expect(resolveAffinityKey({ "x-session-affinity": "ses_child", "x-parent-session-id": "ses_parent" })).toBe("ses_parent");
    expect(resolveAffinityKey({ "x-session-affinity": "ses_child" })).toBe("ses_child");
    // Other session headers do not opt into stickiness.
    expect(resolveAffinityKey({ "x-session-id": "s", "x-claude-code-session-id": "c" })).toBeNull();
    expect(resolveAffinityKey({ "x-session-affinity": "   " })).toBeNull();
    expect(resolveAffinityKey(undefined)).toBeNull();
  });

  it("derives a short, stable prompt_cache_key from the request's own session", () => {
    const own = promptCacheKeyFor({ "x-session-affinity": "ses_child", "x-parent-session-id": "ses_parent" });
    expect(own).toMatch(/^rr-[0-9a-f]{32}$/);
    expect(promptCacheKeyFor({ "x-session-affinity": "ses_child" })).toBe(own);
    expect(promptCacheKeyFor({ "x-parent-session-id": "ses_parent" })).not.toBe(own);
    expect(own).not.toContain("ses_child");
    expect(promptCacheKeyFor({ "x-session-id": "s" })).toBeNull();
  });
});

describe("session member store", () => {
  it("remembers per combo and session, and expires after the idle TTL", () => {
    rememberSessionMember("c", "s1", "p/a", 1000);
    expect(getSessionMember("c", "s1", 1000)).toBe("p/a");
    expect(getSessionMember("other", "s1", 1000)).toBeNull();
    expect(getSessionMember("c", "s2", 1000)).toBeNull();
    expect(getSessionMember("c", "s1", 1000 + SESSION_AFFINITY_CONFIG.ttlMs)).toBe("p/a");
    expect(getSessionMember("c", "s1", 1001 + SESSION_AFFINITY_CONFIG.ttlMs)).toBeNull();
    expect(sessionAffinitySize()).toBe(0);
  });

  it("forgets only the member that failed", () => {
    rememberSessionMember("c", "s", "p/a");
    forgetSessionMember("c", "s", "p/b");
    expect(getSessionMember("c", "s")).toBe("p/a");
    forgetSessionMember("c", "s", "p/a");
    expect(getSessionMember("c", "s")).toBeNull();
  });

  describe("LRU bound", () => {
    const original = SESSION_AFFINITY_CONFIG.maxEntries;
    afterEach(() => { SESSION_AFFINITY_CONFIG.maxEntries = original; });

    it("evicts the least recently served session", () => {
      SESSION_AFFINITY_CONFIG.maxEntries = 2;
      rememberSessionMember("c", "s1", "p/a");
      rememberSessionMember("c", "s2", "p/a");
      rememberSessionMember("c", "s1", "p/b");
      rememberSessionMember("c", "s3", "p/a");
      expect(sessionAffinitySize()).toBe(2);
      expect(getSessionMember("c", "s2")).toBeNull();
      expect(getSessionMember("c", "s1")).toBe("p/b");
      expect(getSessionMember("c", "s3")).toBe("p/a");
    });
  });

  it("moves the member to the front without dropping anyone", () => {
    expect(preferSessionMember(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(preferSessionMember(["a", "b"], "a")).toEqual(["a", "b"]);
    expect(preferSessionMember(["a", "b"], "gone")).toEqual(["a", "b"]);
    expect(preferSessionMember(["a", "b"], null)).toEqual(["a", "b"]);
  });
});

describe("combo member stickiness", () => {
  const models = ["p/a", "p/b", "p/c"];
  const run = ({ sessionKey = null, routedLead = false, strategy = "round-robin", fail = [] } = {}) => {
    const calls = [];
    return handleComboChat({
      body: {},
      models,
      log,
      comboName: "rr",
      comboStrategy: strategy,
      sessionKey,
      routedLead,
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return fail.includes(model) ? rateLimited() : ok(model);
      },
    }).then(async (response) => ({ calls, served: (await response.json()).model }));
  };

  it("keeps rotating per combo when the request has no session key", async () => {
    expect((await run()).served).toBe("p/a");
    expect((await run()).served).toBe("p/b");
    expect((await run()).served).toBe("p/c");
  });

  it("serves a session from the member that served it before, without spending a rotation slot", async () => {
    expect((await run({ sessionKey: "s1" })).served).toBe("p/a");
    // Another client advances the rotation.
    expect((await run()).served).toBe("p/b");
    expect((await run({ sessionKey: "s1" })).served).toBe("p/a");
    expect((await run({ sessionKey: "s1" })).served).toBe("p/a");
    // The rotation resumes where it was.
    expect((await run()).served).toBe("p/c");
  });

  it("moves the session to the next member when its member fails", async () => {
    await run({ sessionKey: "s1" });
    const failed = await run({ sessionKey: "s1", fail: ["p/a"] });
    expect(failed.calls[0]).toBe("p/a");
    expect(failed.served).not.toBe("p/a");
    const next = await run({ sessionKey: "s1" });
    expect(next.calls[0]).toBe(failed.served);
  });

  it("forgets a member that failed on every attempt", async () => {
    rememberSessionMember("rr", "s1", "p/b");
    await run({ sessionKey: "s1", strategy: "fallback", fail: models });
    expect(getSessionMember("rr", "s1")).toBeNull();
  });

  it("applies to fallback combos too", async () => {
    rememberSessionMember("rr", "s1", "p/c");
    const result = await run({ sessionKey: "s1", strategy: "fallback" });
    expect(result.calls).toEqual(["p/c"]);
  });

  it("lets the combo's own routing outrank the remembered member, then remembers the new one", async () => {
    rememberSessionMember("rr", "s1", "p/c");
    const result = await run({ sessionKey: "s1", strategy: "fallback", routedLead: true });
    expect(result.calls).toEqual(["p/a"]);
    expect(getSessionMember("rr", "s1")).toBe("p/a");
  });
});

describe("prompt_cache_key", () => {
  const headers = { "x-session-affinity": "ses_1" };

  it("is set for OpenAI upstreams from the affinity session", () => {
    const body = { model: "gpt-5" };
    expect(applyPromptCacheKey(body, { provider: "openai", format: "openai", headers, clientBody: {} })).toBe(true);
    expect(body.prompt_cache_key).toBe(promptCacheKeyFor(headers));
    const responses = {};
    applyPromptCacheKey(responses, { provider: "openai", format: "openai-responses", headers, clientBody: {} });
    expect(responses.prompt_cache_key).toBe(promptCacheKeyFor(headers));
  });

  it("never overrides a key the client set, even one translation dropped", () => {
    const kept = { prompt_cache_key: "mine" };
    expect(applyPromptCacheKey(kept, { provider: "openai", format: "openai", headers, clientBody: kept })).toBe(false);
    expect(kept.prompt_cache_key).toBe("mine");
    const dropped = {};
    expect(applyPromptCacheKey(dropped, { provider: "openai", format: "openai", headers, clientBody: { prompt_cache_key: "mine" } })).toBe(false);
    expect(dropped).toEqual({});
  });

  it("leaves other upstreams, formats and session-less requests untouched", () => {
    for (const args of [
      { provider: "openrouter", format: "openai", headers },
      { provider: "openai", format: "claude", headers },
      { provider: "openai", format: "openai", headers: { "x-session-id": "s" } },
    ]) {
      const body = {};
      expect(applyPromptCacheKey(body, { ...args, clientBody: {} })).toBe(false);
      expect(body).toEqual({});
    }
  });
});
