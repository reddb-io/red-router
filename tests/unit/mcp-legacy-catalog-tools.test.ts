import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createLegacyCatalogTools,
  parseLegacyKeyCatalog,
  type LegacyCatalogLoader,
} from "../../src/lib/mcp/legacyCatalogTools.ts";
import { handleLegacyMcpBody, type LegacyMcpServer } from "../../src/lib/mcp/legacyProtocol.ts";

const load: LegacyCatalogLoader = async (context) => {
  assert.equal(context.apiKeyId, "key-1");
  return [
    {
      id: "claude/opus",
      name: "Opus",
      owned_by: "claude",
      context_length: 200000,
      capabilities: { vision: true, tool_calling: true },
      pricing: { input: 5, output: 25 },
    },
    {
      id: "combo/default",
      owned_by: "combo",
      context_length: 200000,
      members: ["claude/opus"],
      strategy: "priority",
    },
  ];
};

function server(): LegacyMcpServer {
  return {
    info: { name: "red-router", version: "test" },
    context: { apiKeyId: "key-1", isAdmin: false },
    tools: createLegacyCatalogTools(load),
  };
}

function call(name: string, args: Record<string, unknown> = {}) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

describe("legacy MCP catalog tools", () => {
  it("filters the calling key's catalog and preserves explicit unknown health", async () => {
    const result = await handleLegacyMcpBody(
      call("list_models", { capability: "vision", include_combos: false }),
      server()
    );
    const content = JSON.stringify(result);
    assert.match(content, /claude\/opus/);
    assert.doesNotMatch(content, /combo\/default/);
    assert.match(content, /"state":"unknown"/);
    assert.match(content, /"usable":null/);
    const tools = await handleLegacyMcpBody(call("list_models", { capability: "tools" }), server());
    assert.match(JSON.stringify(tools), /claude\/opus/);
  });

  it("maps current catalog capabilities and excludes non-LLM surfaces", () => {
    const entries = parseLegacyKeyCatalog({
      data: [
        { id: "claude/opus", capabilities: { tool_calling: true } },
        { id: "image/render", type: "image" },
      ],
    });
    assert.deepEqual(
      entries.map((entry) => entry.id),
      ["claude/opus"]
    );
    assert.throws(() => parseLegacyKeyCatalog({ data: [{ name: "missing id" }] }), /catalog/i);
  });

  it("returns an error for a model outside the key-visible catalog", async () => {
    const result = await handleLegacyMcpBody(call("get_model", { id: "private/model" }), server());
    assert.match(JSON.stringify(result), /unknown_model/);
    assert.doesNotMatch(JSON.stringify(result), /private\/model/);
  });

  it("lists only combo entries and rejects extra arguments", async () => {
    const result = await handleLegacyMcpBody(call("list_combos"), server());
    const content = JSON.stringify(result);
    assert.match(content, /combo\/default/);
    assert.match(content, /"total":1/);
    const invalid = await handleLegacyMcpBody(call("list_combos", { secret: true }), server());
    assert.match(JSON.stringify(invalid), /"code":-32602/);
  });
});
