// Account health: EWMA latency and error rate with a breaker per account/model,
// used by the `health` strategy and to push failing combo members to the back.
import { beforeEach, describe, expect, it } from "vitest";
import {
  recordSuccess, recordFailure, getHealth, rankByHealth, isProviderModelOpen, resetProviderHealth,
} from "../../open-sse/services/providerHealth.js";
import { demoteFailingMembers } from "../../open-sse/services/combo.js";

const T0 = 1_800_000_000_000;
const conns = (...ids) => ids.map((id) => ({ id }));
const ids = (list) => list.map((c) => c.id);

beforeEach(() => resetProviderHealth());

describe("health tracking", () => {
  it("smooths latency and error rate", () => {
    recordSuccess({ connectionId: "a", model: "m", ttftMs: 1000, latencyMs: 4000, now: T0 });
    recordSuccess({ connectionId: "a", model: "m", ttftMs: 2000, latencyMs: 4000, now: T0 });
    recordFailure({ connectionId: "a", model: "m", now: T0 });
    expect(getHealth("a", "m", T0)).toMatchObject({ samples: 3, ttftMs: 1300, latencyMs: 4000, errorRate: 0.3, breaker: "closed" });
  });

  it("opens the breaker after 3 straight failures, half-opens after cooldown, doubles on a failed trial", () => {
    for (let i = 0; i < 3; i++) recordFailure({ connectionId: "a", model: "m", now: T0 });
    expect(getHealth("a", "m", T0).breaker).toBe("open");
    expect(getHealth("a", "m", T0 + 30_000).breaker).toBe("half-open");
    recordFailure({ connectionId: "a", model: "m", now: T0 + 30_000 });
    expect(getHealth("a", "m", T0 + 30_000 + 59_000).breaker).toBe("open");
    expect(getHealth("a", "m", T0 + 30_000 + 60_000).breaker).toBe("half-open");
    recordSuccess({ connectionId: "a", model: "m", ttftMs: 100, now: T0 + 100_000 });
    expect(getHealth("a", "m", T0 + 100_000).breaker).toBe("closed");
  });

  it("is kept per model and ignores the public noauth account", () => {
    recordFailure({ connectionId: "a", model: "m1", now: T0 });
    expect(getHealth("a", "m2", T0)).toBeNull();
    recordSuccess({ connectionId: "noauth", model: "m1", now: T0 });
    expect(getHealth("noauth", "m1", T0)).toBeNull();
  });
});

describe("rankByHealth", () => {
  it("tries unmeasured accounts first, then orders by breaker, errors and speed; ties keep priority", () => {
    recordSuccess({ connectionId: "slow", model: "m", ttftMs: 4000, now: T0 });
    recordSuccess({ connectionId: "fast", model: "m", ttftMs: 1000, now: T0 });
    recordSuccess({ connectionId: "fast2", model: "m", ttftMs: 1100, now: T0 });
    for (let i = 0; i < 3; i++) recordFailure({ connectionId: "broken", model: "m", now: T0 });
    const ranked = rankByHealth(conns("broken", "slow", "fast2", "new", "fast"), "m", { now: T0 });
    // fast2 is within 25% of fast, so priority order (fast2 listed first) holds.
    expect(ids(ranked)).toEqual(["new", "fast2", "fast", "slow", "broken"]);
  });

  it("explores another healthy account with the configured probability", () => {
    recordSuccess({ connectionId: "a", model: "m", ttftMs: 100, now: T0 });
    recordSuccess({ connectionId: "b", model: "m", ttftMs: 5000, now: T0 });
    for (let i = 0; i < 3; i++) recordFailure({ connectionId: "c", model: "m", now: T0 });
    const draws = [0.01, 0.0];
    const ranked = rankByHealth(conns("a", "b", "c"), "m", { now: T0, explore: 0.05, random: () => draws.shift() });
    expect(ids(ranked)).toEqual(["b", "a", "c"]);
    expect(ids(rankByHealth(conns("a", "b", "c"), "m", { now: T0, explore: 0.05, random: () => 0.9 }))).toEqual(["a", "b", "c"]);
  });
});

describe("combo member demotion", () => {
  const failAll = (provider, model, accounts) => {
    for (const connectionId of accounts) for (let i = 0; i < 3; i++) recordFailure({ provider, connectionId, model });
  };

  it("moves members whose provider/model is failing across accounts to the back", () => {
    failAll("claude", "claude-opus-5-5", ["c1"]);
    expect(isProviderModelOpen("claude", "claude-opus-5-5")).toBe(true);
    const out = demoteFailingMembers(["cc/claude-opus-5-5(high)", "openai/gpt-5", "claude-code/claude-sonnet-5"]);
    expect(out.models).toEqual(["openai/gpt-5", "claude-code/claude-sonnet-5", "cc/claude-opus-5-5(high)"]);
    expect(out.moved).toEqual(["cc/claude-opus-5-5(high)"]);
  });

  it("keeps a routed lead and never reorders when every member is failing", () => {
    failAll("claude", "claude-opus-5-5", ["c1"]);
    failAll("openai", "gpt-5", ["o1"]);
    expect(demoteFailingMembers(["cc/claude-opus-5-5", "openai/gpt-5"]).models).toEqual(["cc/claude-opus-5-5", "openai/gpt-5"]);
    expect(demoteFailingMembers(["cc/claude-opus-5-5", "gemini/gemini-3-pro", "openai/gpt-5"], { keepLead: true }).models)
      .toEqual(["cc/claude-opus-5-5", "gemini/gemini-3-pro", "openai/gpt-5"]);
  });
});

describe("summarizeConnectionHealth", () => {
  it("averages one account across its models by samples", async () => {
    const { summarizeConnectionHealth } = await import("../../open-sse/services/providerHealth.js");
    recordSuccess({ connectionId: "a", model: "m1", ttftMs: 1000, now: T0 });
    recordSuccess({ connectionId: "a", model: "m1", ttftMs: 1000, now: T0 });
    recordSuccess({ connectionId: "a", model: "m2", ttftMs: 4000, now: T0 });
    for (let i = 0; i < 3; i++) recordFailure({ connectionId: "a", model: "m3", now: T0 });
    recordSuccess({ connectionId: "ab", model: "m1", ttftMs: 9000, now: T0 });
    expect(summarizeConnectionHealth("a", T0)).toMatchObject({ samples: 6, ttftMs: 2000, openModels: 1 });
    expect(summarizeConnectionHealth("nobody", T0)).toBeNull();
  });
});
