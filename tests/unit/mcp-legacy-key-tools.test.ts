import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLegacyKeyTools, type LegacyKeyStore } from "../../src/lib/mcp/legacyKeyTools.ts";
import { handleLegacyMcpBody, type LegacyMcpServer } from "../../src/lib/mcp/legacyProtocol.ts";

const secret = "sk-do-not-leak";
const key = {
  id: "key-1",
  name: "Client",
  createdAt: "2026-09-27T00:00:00.000Z",
  key: secret,
  keyHash: "private-hash",
  machineId: "private-machine",
  isActive: true,
  modelAccessMode: "all",
  allowedModels: [],
  blockedModels: [],
  allowedCombos: [],
  allowedConnections: ["connection-1"],
  scopes: ["manage"],
  catalogScope: "all",
  maxRequestsPerDay: null,
  maxRequestsPerMinute: null,
  dailyUsageLimitUsd: null,
  weeklyUsageLimitUsd: null,
  expiresAt: null,
};

function server(isAdmin: boolean): LegacyMcpServer {
  const caller = { ...key, scopes: isAdmin ? ["manage"] : [] };
  const store: LegacyKeyStore = {
    getById: async (id) => (id === key.id ? (caller as never) : null),
    list: async () => [key as never],
    limits: (id) => ({
      apiKeyId: id,
      tpmLimit: null,
      rpmLimit: 5,
      dailyTokensLimit: 100,
      monthlyAmountUsd: 2,
    }),
  };
  return {
    info: { name: "red-router", version: "test" },
    context: { apiKeyId: key.id, isAdmin },
    tools: createLegacyKeyTools(store),
  };
}

function call(name: string) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name } });
}

describe("legacy MCP API-key tools", () => {
  it("returns only allowlisted metadata for the calling key", async () => {
    const result = await handleLegacyMcpBody(call("get_api_key"), server(false));
    const serialized = JSON.stringify(result);
    assert.match(serialized, /"id":"key-1"/);
    assert.match(serialized, /"bound_accounts":1/);
    assert.match(serialized, /"role":"standard"/);
    assert.match(serialized, /"tokensPerDay":100/);
    assert.doesNotMatch(serialized, /"tags":/);
    assert.doesNotMatch(serialized, /sk-do-not-leak|private-hash|private-machine|connection-1/);
  });

  it("hides administrative listing from ordinary keys", async () => {
    const listed = await handleLegacyMcpBody(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      server(false)
    );
    assert.doesNotMatch(JSON.stringify(listed), /list_api_keys/);
    const denied = await handleLegacyMcpBody(call("list_api_keys"), server(false));
    assert.match(JSON.stringify(denied), /"code":-32602/);
  });

  it("allows management-scoped listing without returning secrets", async () => {
    const result = await handleLegacyMcpBody(call("list_api_keys"), server(true));
    const serialized = JSON.stringify(result);
    assert.match(serialized, /"total":1/);
    assert.match(serialized, /"role":"admin"/);
    assert.doesNotMatch(serialized, /sk-do-not-leak|private-hash|private-machine|connection-1/);
  });
});
