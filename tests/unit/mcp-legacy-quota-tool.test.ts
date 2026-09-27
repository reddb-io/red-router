import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createLegacyQuotaTool,
  parseLegacyQuotaWindows,
  type LegacyQuotaStore,
} from "../../src/lib/mcp/legacyQuotaTool.ts";
import { handleLegacyMcpBody, type LegacyMcpServer } from "../../src/lib/mcp/legacyProtocol.ts";

const readConnections: string[] = [];
const refreshedConnections: string[] = [];
const store: LegacyQuotaStore = {
  keyScope: async (token) =>
    token === "pool-key"
      ? { allowedConnections: [], allowedQuotas: ["pool-1"], quotaConnections: ["allowed"] }
      : token === "empty-pool-key"
        ? { allowedConnections: [], allowedQuotas: ["pool-2"], quotaConnections: [] }
        : { allowedConnections: ["allowed"], allowedQuotas: [], quotaConnections: [] },
  connections: async () => [
    { id: "allowed", provider: "claude", isActive: true },
    { id: "private", provider: "claude", isActive: true },
  ],
  windows: (id) => {
    readConnections.push(id);
    return [
      {
        name: "5h",
        used: null,
        total: null,
        remaining: null,
        remainingPct: 60,
        unlimited: null,
        resetAt: null,
        observedAt: "2026-09-27T00:00:00Z",
      },
    ];
  },
  refresh: async (id) => {
    refreshedConnections.push(id);
    return [
      {
        name: "5h",
        used: 4,
        total: 10,
        remaining: 6,
        remainingPct: 60,
        unlimited: false,
        resetAt: null,
        observedAt: "2026-09-27T01:00:00Z",
      },
    ];
  },
};

function server(token = "my-key"): LegacyMcpServer {
  return {
    info: { name: "red-router", version: "test" },
    context: { apiKeyId: "key-1", apiKeyToken: token, isAdmin: false },
    tools: [createLegacyQuotaTool(store)],
  };
}

function call(args: Record<string, unknown> = {}) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_quotas", arguments: args },
  });
}

describe("legacy MCP quota tool", () => {
  it("preserves cached absolute values and provider-reported remaining percentage", () => {
    assert.deepEqual(
      parseLegacyQuotaWindows(
        {
          monthly: {
            used: 2,
            total: 10,
            remaining: 8,
            remainingPercentage: 73,
            resetAt: "2026-10-01T00:00:00Z",
            unlimited: false,
          },
        },
        "2026-09-27T01:00:00Z"
      ),
      [
        {
          name: "monthly",
          used: 2,
          total: 10,
          remaining: 8,
          remainingPct: 73,
          unlimited: false,
          resetAt: "2026-10-01T00:00:00Z",
          observedAt: "2026-09-27T01:00:00Z",
        },
      ]
    );
  });

  it("only reads the caller's allowed connection and strips raw provider data", async () => {
    readConnections.length = 0;
    const result = await handleLegacyMcpBody(call(), server());
    const serialized = JSON.stringify(result);
    assert.deepEqual(readConnections, ["allowed"]);
    assert.match(serialized, /"remaining_pct":60/);
    assert.doesNotMatch(serialized, /private/);
  });

  it("refreshes only the caller's scoped connections and never widens an empty pool", async () => {
    readConnections.length = 0;
    refreshedConnections.length = 0;
    const scoped = await handleLegacyMcpBody(call(), server("pool-key"));
    assert.match(JSON.stringify(scoped), /"total_accounts":1/);
    const empty = await handleLegacyMcpBody(call({ refresh: true }), server("empty-pool-key"));
    assert.match(JSON.stringify(empty), /"total_accounts":0/);
    const refresh = await handleLegacyMcpBody(call({ refresh: true }), server("pool-key"));
    assert.match(JSON.stringify(refresh), /"used":4/);
    assert.match(JSON.stringify(refresh), /"remaining":6/);
    assert.doesNotMatch(JSON.stringify(refresh), /private/);
    assert.deepEqual(refreshedConnections, ["allowed"]);
    assert.deepEqual(readConnections, ["allowed"]);
  });

  it("sanitizes upstream refresh errors and falls back to the last scoped report", async () => {
    const failingStore: LegacyQuotaStore = {
      ...store,
      refresh: async () => {
        throw new Error("secret upstream token and stack trace");
      },
    };
    const result = await handleLegacyMcpBody(call({ refresh: true }), {
      ...server(),
      tools: [createLegacyQuotaTool(failingStore)],
    });
    const body = JSON.stringify(result);
    assert.match(body, /quota refresh failed/);
    assert.match(body, /"remaining_pct":60/);
    assert.doesNotMatch(body, /secret upstream token|stack trace|private/);
  });

  it("limits concurrent upstream refreshes to four scoped connections", async () => {
    let active = 0;
    let peak = 0;
    const concurrentStore: LegacyQuotaStore = {
      ...store,
      keyScope: async () => ({
        allowedConnections: ["1", "2", "3", "4", "5", "6"],
        allowedQuotas: [],
        quotaConnections: [],
      }),
      connections: async () =>
        ["1", "2", "3", "4", "5", "6", "private"].map((id) => ({
          id,
          provider: "claude",
          isActive: true,
        })),
      refresh: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return [];
      },
    };
    const result = await handleLegacyMcpBody(call({ refresh: true }), {
      ...server(),
      tools: [createLegacyQuotaTool(concurrentStore)],
    });
    assert.match(JSON.stringify(result), /"total_accounts":6/);
    assert.equal(peak, 4);
    assert.doesNotMatch(JSON.stringify(result), /private/);
  });
});
