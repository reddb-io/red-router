import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLegacyQuotaTool, type LegacyQuotaStore } from "../../src/lib/mcp/legacyQuotaTool.ts";
import { handleLegacyMcpBody, type LegacyMcpServer } from "../../src/lib/mcp/legacyProtocol.ts";

const readConnections: string[] = [];
const store: LegacyQuotaStore = {
  keyScope: async (token) =>
    token === "pool-key"
      ? { allowedConnections: [], allowedQuotas: ["pool-1"] }
      : { allowedConnections: ["allowed"], allowedQuotas: [] },
  connections: async () => [
    { id: "allowed", provider: "claude", isActive: true },
    { id: "private", provider: "claude", isActive: true },
  ],
  windows: (id) => {
    readConnections.push(id);
    return [{ name: "5h", remainingPct: 60, resetAt: null, observedAt: "2026-09-27T00:00:00Z" }];
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
  it("only reads the caller's allowed connection and strips raw provider data", async () => {
    readConnections.length = 0;
    const result = await handleLegacyMcpBody(call(), server());
    const serialized = JSON.stringify(result);
    assert.deepEqual(readConnections, ["allowed"]);
    assert.match(serialized, /"remaining_pct":60/);
    assert.doesNotMatch(serialized, /private/);
  });

  it("fails closed for quota-pool keys and unsupported live refresh", async () => {
    readConnections.length = 0;
    const scoped = await handleLegacyMcpBody(call(), server("pool-key"));
    assert.match(JSON.stringify(scoped), /unsupported_scope/);
    const refresh = await handleLegacyMcpBody(call({ refresh: true }), server());
    assert.match(JSON.stringify(refresh), /unsupported_refresh/);
    assert.deepEqual(readConnections, []);
  });
});
