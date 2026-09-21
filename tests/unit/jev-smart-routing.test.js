import { describe, it, expect, vi, beforeEach } from "vitest";

import { reorderModelsForTier } from "../../open-sse/services/combo.js";
import { classifyTier, buildJevState, resetJevBreaker } from "../../open-sse/services/jevClassifier.js";
import { JEV_TIERS } from "../../open-sse/config/jev.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

// Build a Jev HTTP-200 response stub carrying the given answers.tier shape.
function jevOk({ choice, confidence = 1, probabilities, model = "jev-1.13.0", usage = { input_tokens: 400, output_tokens: 50 } }) {
  const json = {
    model,
    answers: { tier: { type: "choice", choice, confidence, probabilities: probabilities || { [choice]: confidence } } },
    usage,
  };
  return { ok: true, status: 200, json: async () => json };
}
function jevHttp(status = 500) {
  return { ok: false, status, json: async () => ({ error: { message: "boom" } }) };
}

const TIER_MAP = {
  SIMPLE: "glm/glm-4.7",
  MEDIUM: "kr/claude-sonnet-4.5",
  COMPLEX: "cc/claude-opus-4-5",
  REASONING: "cc/claude-opus-4-5",
};

// ---------------------------------------------------------------------------
// reorderModelsForTier — pure, network-free
// ---------------------------------------------------------------------------
describe("reorderModelsForTier", () => {
  it("moves the tier's model to the front, keeping the rest as the fallback ladder", () => {
    const models = ["cc/claude-opus-4-5", "glm/glm-4.7", "kr/claude-sonnet-4.5"];
    expect(reorderModelsForTier(models, "SIMPLE", TIER_MAP)).toEqual([
      "glm/glm-4.7", "cc/claude-opus-4-5", "kr/claude-sonnet-4.5",
    ]);
  });

  it("is a no-op when the tier's model already leads", () => {
    const models = ["glm/glm-4.7", "cc/claude-opus-4-5"];
    expect(reorderModelsForTier(models, "SIMPLE", TIER_MAP)).toEqual(models);
  });

  it("prepends a tier model that is not in the combo (new primary, rest as fallback)", () => {
    const models = ["glm/glm-4.7", "kr/claude-sonnet-4.5"];
    expect(reorderModelsForTier(models, "COMPLEX", TIER_MAP)).toEqual([
      "cc/claude-opus-4-5", "glm/glm-4.7", "kr/claude-sonnet-4.5",
    ]);
  });

  it("never drops a model", () => {
    const models = ["a/1", "b/2", "c/3"];
    const out = reorderModelsForTier(models, "MEDIUM", { MEDIUM: "b/2" });
    expect(out).toHaveLength(models.length);
    expect(new Set(out)).toEqual(new Set(models));
  });

  it("fails open (returns input) when there is no candidate for the tier", () => {
    const models = ["a/1", "b/2"];
    expect(reorderModelsForTier(models, "REASONING", { SIMPLE: "a/1" })).toEqual(models);
    expect(reorderModelsForTier(models, "SIMPLE", undefined)).toEqual(models);
    expect(reorderModelsForTier(models, "", TIER_MAP)).toEqual(models);
    expect(reorderModelsForTier([], "SIMPLE", TIER_MAP)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildJevState — bounded, current-turn-only
// ---------------------------------------------------------------------------
describe("buildJevState", () => {
  it("uses the trailing user turn only (OpenAI shape)", () => {
    const body = { messages: [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "current ask" },
    ] };
    expect(buildJevState(body)).toBe("current ask");
  });

  it("extracts text from Claude content-block arrays", () => {
    const body = { messages: [
      { role: "user", content: [{ type: "text", text: "fix the race" }, { type: "image", source: {} }] },
    ] };
    expect(buildJevState(body)).toBe("fix the race");
  });

  it("reads Gemini contents/parts", () => {
    const body = { contents: [{ role: "user", parts: [{ text: "gemini ask" }] }] };
    expect(buildJevState(body)).toBe("gemini ask");
  });

  it("bounds the state to the char budget", () => {
    const body = { messages: [{ role: "user", content: "x".repeat(10000) }] };
    expect(buildJevState(body, 4000)).toHaveLength(4000);
  });

  it("returns '' for an empty/absent ask", () => {
    expect(buildJevState({ messages: [] })).toBe("");
    expect(buildJevState({})).toBe("");
  });
});

// ---------------------------------------------------------------------------
// classifyTier — fail-open matrix (all offline via injected fetchImpl)
// ---------------------------------------------------------------------------
describe("classifyTier", () => {
  beforeEach(() => resetJevBreaker());

  const baseOpts = {
    body: { messages: [{ role: "user", content: "write a function" }] },
    log,
    apiKey: "test-key",
    fetchImpl: vi.fn(async () => jevOk({ choice: "MEDIUM", confidence: 0.99 })),
  };

  it("returns the tier + confidence + spend on a confident 200", async () => {
    const r = await classifyTier(baseOpts);
    expect(r).toMatchObject({ tier: "MEDIUM", confidence: 0.99, source: "jev", model: "jev-1.13.0" });
    expect(JEV_TIERS).toContain(r.tier);
    // spend = 400/1e6 * 0.042 + 50/1e6 * 0 = 0.0000168
    expect(r.spendUsd).toBeCloseTo(0.0000168, 10);
    // POSTed to /v1/systemone with a Bearer header + a single choice question.
    const [url, init] = baseOpts.fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(init.body).questions.tier.type).toBe("choice");
  });

  it("uses the native System One adapter without requiring a TypeSafe env key", async () => {
    const requestImpl = vi.fn(async () => jevOk({ choice: "COMPLEX", confidence: 0.91 }));
    const r = await classifyTier({
      body: baseOpts.body,
      log,
      apiKey: undefined,
      requestImpl,
    });
    expect(r).toMatchObject({ tier: "COMPLEX", confidence: 0.91 });
    expect(requestImpl).toHaveBeenCalledWith(
      expect.objectContaining({ model: "jev-latest", questions: expect.any(Object) }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("fails open (null) when no API key is configured", async () => {
    const r = await classifyTier({ ...baseOpts, apiKey: undefined, fetchImpl: vi.fn() });
    expect(r).toBeNull();
  });

  it("fails open (null) on an empty state without calling Jev", async () => {
    const fetchImpl = vi.fn();
    const r = await classifyTier({ ...baseOpts, body: { messages: [] }, fetchImpl });
    expect(r).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails open (null) on a non-200 HTTP response", async () => {
    const r = await classifyTier({ ...baseOpts, fetchImpl: vi.fn(async () => jevHttp(503)) });
    expect(r).toBeNull();
  });

  it("fails open (null) on an unparseable response body", async () => {
    const r = await classifyTier({ ...baseOpts, fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } })) });
    expect(r).toBeNull();
  });

  it("fails open (null) on an unknown tier", async () => {
    const r = await classifyTier({ ...baseOpts, fetchImpl: vi.fn(async () => jevOk({ choice: "GALACTIC", confidence: 1 })) });
    expect(r).toBeNull();
  });

  it("fails open (null) when confidence is below the threshold", async () => {
    const r = await classifyTier({ ...baseOpts, minConfidence: 0.5, fetchImpl: vi.fn(async () => jevOk({ choice: "MEDIUM", confidence: 0.2 })) });
    expect(r).toBeNull();
  });

  it("honours a custom minConfidence", async () => {
    const r = await classifyTier({ ...baseOpts, minConfidence: 0.1, fetchImpl: vi.fn(async () => jevOk({ choice: "SIMPLE", confidence: 0.2 })) });
    expect(r?.tier).toBe("SIMPLE");
  });

  it("fails open (null) on a timeout and trips the breaker", async () => {
    let clock = 0;
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    // fetchImpl that never resolves; the AbortController fires the timeout.
    const fetchImpl = vi.fn(() => new Promise((_, reject) => setTimeout(() => reject(abortErr), 50)));
    const r = await classifyTier({ ...baseOpts, fetchImpl, timeoutMs: 5, now: () => clock });
    expect(r).toBeNull();

    // Breaker is now open: a second call is skipped WITHOUT hitting fetch.
    const fetch2 = vi.fn();
    const r2 = await classifyTier({ ...baseOpts, fetchImpl: fetch2, timeoutMs: 5, now: () => clock + 1000 });
    expect(r2).toBeNull();
    expect(fetch2).not.toHaveBeenCalled();
  });

  it("lets one probe through after the breaker cooldown, then closes on success", async () => {
    let clock = 0;
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    await classifyTier({ ...baseOpts, fetchImpl: vi.fn(() => new Promise((_, reject) => setTimeout(() => reject(abortErr), 50))), timeoutMs: 5, now: () => clock });

    // Advance past the 30s cooldown — the half-open probe is allowed.
    clock += 31000;
    const probe = vi.fn(async () => jevOk({ choice: "COMPLEX", confidence: 0.9 }));
    const r = await classifyTier({ ...baseOpts, fetchImpl: probe, timeoutMs: 50, now: () => clock });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(r?.tier).toBe("COMPLEX");
  });

  it("never leaks the API key into the returned object or logs", async () => {
    const lines = [];
    const spyLog = { info: (t, m) => lines.push(String(m)), warn: (t, m) => lines.push(String(m)), debug: (t, m) => lines.push(String(m)) };
    const r = await classifyTier({ ...baseOpts, log: spyLog });
    expect(JSON.stringify(r)).not.toContain("test-key");
    expect(lines.join("\n")).not.toContain("test-key");
  });
});
