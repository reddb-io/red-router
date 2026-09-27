import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLegacyUsageTool, type LegacyUsageStore } from "../../src/lib/mcp/legacyUsageTool.ts";
import { handleLegacyMcpBody, type LegacyMcpServer } from "../../src/lib/mcp/legacyProtocol.ts";

const reads: string[] = [];
const store: LegacyUsageStore = {
  keyExists: async (id) => id === "other-key",
  usage: (id) => {
    reads.push(id);
    return {
      totals: { requests: 2, errors: 0, prompt_tokens: 10, completion_tokens: 5, cost: 0.1 },
      by_model: [],
      tokens_today: 15,
    };
  },
  monthCost: () => 0.4,
  limits: (id) => ({ apiKeyId: id, rpmLimit: 10, tpmLimit: null, monthlyAmountUsd: 1 }),
};

function server(isAdmin: boolean): LegacyMcpServer {
  return {
    info: { name: "red-router", version: "test" },
    context: { apiKeyId: "my-key", isAdmin },
    tools: [createLegacyUsageTool(store)],
  };
}

function call(args: Record<string, unknown> = {}) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_usage", arguments: args },
  });
}

describe("legacy MCP usage tool", () => {
  it("uses the caller's key and reports ledger-backed limits", async () => {
    reads.length = 0;
    const result = await handleLegacyMcpBody(call(), server(false));
    const serialized = JSON.stringify(result);
    assert.deepEqual(reads, ["my-key"]);
    assert.match(serialized, /"api_key_id":"my-key"/);
    assert.match(serialized, /request_cost_ledger/);
    assert.match(serialized, /"usd_this_month":0.6/);
  });

  it("never reads another key for a non-management caller", async () => {
    reads.length = 0;
    const result = await handleLegacyMcpBody(call({ api_key_id: "other-key" }), server(false));
    assert.deepEqual(reads, []);
    assert.match(JSON.stringify(result), /forbidden/);
  });

  it("allows an existing target key only to management callers", async () => {
    reads.length = 0;
    const result = await handleLegacyMcpBody(call({ api_key_id: "other-key" }), server(true));
    assert.deepEqual(reads, ["other-key"]);
    assert.match(JSON.stringify(result), /"api_key_id":"other-key"/);
    const unknown = await handleLegacyMcpBody(call({ api_key_id: "missing-key" }), server(true));
    assert.match(JSON.stringify(unknown), /unknown_key/);
  });
});
