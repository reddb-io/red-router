import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createLegacyProviderTool,
  type LegacyProviderStore,
} from "../../src/lib/mcp/legacyProviderTool.ts";
import { handleLegacyMcpBody, type LegacyMcpServer } from "../../src/lib/mcp/legacyProtocol.ts";

const store: LegacyProviderStore = {
  keyScope: async (token) =>
    token === "pool-key"
      ? { allowedConnections: [], allowedQuotas: ["pool-1"], quotaConnections: ["allowed"] }
      : token === "empty-pool-key"
        ? { allowedConnections: [], allowedQuotas: ["pool-2"], quotaConnections: [] }
        : { allowedConnections: ["allowed"], allowedQuotas: [], quotaConnections: [] },
  connections: async () => [
    {
      id: "allowed",
      provider: "claude",
      isActive: true,
      rateLimitedUntil: null,
      testStatus: "success",
    },
    {
      id: "private",
      provider: "claude",
      isActive: true,
      rateLimitedUntil: null,
      testStatus: "success",
    },
    {
      id: "other-provider",
      provider: "codex",
      isActive: true,
      rateLimitedUntil: null,
      testStatus: "success",
    },
  ],
  modelOwners: async () => [{ id: "claude/opus", ownedBy: "claude" }],
};

function server(token = "my-key"): LegacyMcpServer {
  return {
    info: { name: "red-router", version: "test" },
    context: { apiKeyId: "key-1", apiKeyToken: token, isAdmin: false },
    tools: [createLegacyProviderTool(store)],
  };
}

const call = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "list_providers", arguments: {} },
});

describe("legacy MCP provider tool", () => {
  it("reveals only key-allowed connections with visible models", async () => {
    const result = await handleLegacyMcpBody(call, server());
    const serialized = JSON.stringify(result);
    assert.match(serialized, /"total":1/);
    assert.match(serialized, /"models":1/);
    assert.match(serialized, /"ok":1/);
    assert.doesNotMatch(serialized, /private|other-provider|codex/);
  });

  it("resolves quota-pool keys and fails closed on an empty pool", async () => {
    const result = await handleLegacyMcpBody(call, server("pool-key"));
    assert.match(JSON.stringify(result), /"total":1/);
    const empty = await handleLegacyMcpBody(call, server("empty-pool-key"));
    assert.match(JSON.stringify(empty), /"total":0/);
  });
});
