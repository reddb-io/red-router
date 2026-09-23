// Quota-aware account selection: skip accounts whose reported quota is used up,
// keep a reserve, prefer the window that resets first, and treat old reports as
// unknown.
import { beforeEach, describe, expect, it } from "vitest";
import {
  recordQuotaSnapshot, quotaStanding, orderByQuota, quotaAppliesToModel, remainingFraction, resetQuotaSnapshots, QUOTA_SNAPSHOT_TTL_MS,
} from "@/sse/services/quotaSnapshot.js";
import { runQuotaSnapshotTick } from "@/shared/services/quotaSnapshotScheduler.js";

const NOW = Date.parse("2026-07-20T12:00:00Z");
const inHours = (h) => new Date(NOW + h * 3_600_000).toISOString();
const conns = (...ids) => ids.map((id) => ({ id }));
const ids = (list) => list.map((c) => c.id);

beforeEach(() => resetQuotaSnapshots());

describe("quota windows", () => {
  it("apply to a model unless they name another model family", () => {
    expect(quotaAppliesToModel("session (5h)", "claude-sonnet-5")).toBe(true);
    expect(quotaAppliesToModel("weekly Opus (7d)", "claude-opus-5-5")).toBe(true);
    expect(quotaAppliesToModel("weekly Opus (7d)", "claude-sonnet-5")).toBe(false);
    expect(quotaAppliesToModel("weekly Opus (7d)", null)).toBe(false);
  });

  it("report the fraction left", () => {
    expect(remainingFraction({ total: 100, used: 25 })).toBe(0.75);
    expect(remainingFraction({ total: 10, remaining: 1 })).toBe(0.1);
    expect(remainingFraction({ unlimited: true })).toBeNull();
    expect(remainingFraction({ total: 0, used: 0 })).toBeNull();
  });
});

describe("quotaStanding", () => {
  it("is unknown without a report or once the report is older than 30 min", () => {
    expect(quotaStanding("a", "m", NOW).known).toBe(false);
    recordQuotaSnapshot("a", { quotas: { daily: { total: 10, used: 10, resetAt: inHours(5) } } }, NOW);
    expect(quotaStanding("a", "m", NOW)).toMatchObject({ known: true, exhausted: true, tightest: 0 });
    expect(quotaStanding("a", "m", NOW + QUOTA_SNAPSHOT_TTL_MS + 1).known).toBe(false);
  });

  it("ignores windows whose reset already passed and ones for other models", () => {
    recordQuotaSnapshot("a", { quotas: {
      "session (5h)": { total: 10, used: 10, resetAt: inHours(-1) },
      "weekly Opus (7d)": { total: 10, used: 10, resetAt: inHours(40) },
      "weekly (7d)": { total: 100, used: 40, resetAt: inHours(30) },
    } }, NOW);
    expect(quotaStanding("a", "claude-sonnet-5", NOW)).toMatchObject({ exhausted: false, tightest: 0.6, resetAtMs: Date.parse(inHours(30)) });
    expect(quotaStanding("a", "claude-opus-5-5", NOW).exhausted).toBe(true);
  });

  it("ignores empty reports", () => {
    recordQuotaSnapshot("a", { message: "Usage API not implemented" }, NOW);
    expect(quotaStanding("a", "m", NOW).known).toBe(false);
  });
});

describe("orderByQuota", () => {
  it("drops exhausted accounts, puts ones under the reserve last, and leads with the soonest reset", () => {
    recordQuotaSnapshot("empty", { quotas: { d: { total: 10, used: 10, resetAt: inHours(2) } } }, NOW);
    recordQuotaSnapshot("low", { quotas: { d: { total: 100, used: 95, resetAt: inHours(1) } } }, NOW);
    recordQuotaSnapshot("late", { quotas: { d: { total: 100, used: 10, resetAt: inHours(20) } } }, NOW);
    recordQuotaSnapshot("soon", { quotas: { d: { total: 100, used: 50, resetAt: inHours(3) } } }, NOW);
    const ordered = orderByQuota(conns("unknown", "empty", "low", "late", "soon"), "m", { reservePercent: 10, now: NOW });
    expect(ids(ordered)).toEqual(["soon", "late", "unknown", "low"]);
  });

  it("keeps every account when all are exhausted, so the upstream decides", () => {
    recordQuotaSnapshot("a", { quotas: { d: { total: 1, used: 1, resetAt: inHours(1) } } }, NOW);
    recordQuotaSnapshot("b", { quotas: { d: { total: 1, used: 1, resetAt: inHours(1) } } }, NOW);
    expect(ids(orderByQuota(conns("a", "b"), "m", { now: NOW }))).toEqual(["a", "b"]);
  });
});

describe("runQuotaSnapshotTick", () => {
  it("reads quota only for accounts whose provider has a usage API and survives one failing", async () => {
    const calls = [];
    await runQuotaSnapshotTick({
      getProviderConnections: async () => [
        { id: "c1", provider: "claude", authType: "apikey" },
        { id: "c2", provider: "nousage", authType: "apikey" },
        { id: "c3", provider: "codex", authType: "apikey" },
      ],
      hasUsageHandler: (p) => p !== "nousage",
      resolveConnectionProxyConfig: async () => ({}),
      refreshAndUpdateCredentials: async (c) => ({ connection: c }),
      getUsageForProvider: async (c) => {
        calls.push(c.id);
        if (c.id === "c3") throw new Error("boom");
        return { quotas: { d: { total: 10, used: 10 } } };
      },
    }, { running: false });
    expect(calls).toEqual(["c1", "c3"]);
    expect(quotaStanding("c1", "m").exhausted).toBe(true);
    expect(quotaStanding("c3", "m").known).toBe(false);
  });
});
