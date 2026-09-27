import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { z } from "zod";

import {
  handleLegacyMcpBody,
  LEGACY_MCP_SCHEMA_VERSION,
  LegacyMcpToolError,
  MAX_LEGACY_MCP_BODY_BYTES,
  type LegacyMcpServer,
} from "../../src/lib/mcp/legacyProtocol.ts";

function server(isAdmin = false): LegacyMcpServer {
  return {
    info: { name: "red-router", version: "test" },
    context: { apiKeyId: "key-1", isAdmin },
    tools: [
      {
        name: "get_model",
        description: "A key-scoped model",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        argsSchema: z.object({ id: z.string() }).strict(),
        run: async (args, context) => ({ id: args.id, key_id: context.apiKeyId }),
      },
      {
        name: "create_api_key",
        admin: true,
        description: "Administrative key creation",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        argsSchema: z.object({}).strict(),
        run: async () => ({ created: true }),
      },
      {
        name: "failure",
        description: "Fail safely",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        argsSchema: z.object({}).strict(),
        run: async () => {
          throw new Error("password=private-secret at /private/stack.ts:1");
        },
      },
      {
        name: "known_failure",
        description: "A known failure",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        argsSchema: z.object({}).strict(),
        run: async () => {
          throw new LegacyMcpToolError("unknown_model", "No model for this key");
        },
      },
    ],
  };
}

function rpc(method: string, params: unknown = {}, id: number | "notification" = 1) {
  return JSON.stringify({
    jsonrpc: "2.0",
    ...(id === "notification" ? {} : { id }),
    method,
    params,
  });
}

describe("legacy MCP JSON-RPC compatibility boundary", () => {
  it("negotiates versions and preserves the legacy schema marker", async () => {
    const result = await handleLegacyMcpBody(
      rpc("initialize", { protocolVersion: "2025-03-26" }),
      server()
    );
    assert.match(JSON.stringify(result), /"protocolVersion":"2025-03-26"/);
    assert.match(
      JSON.stringify(result),
      new RegExp(`"io.reddb/red-router-mcp-version":${LEGACY_MCP_SCHEMA_VERSION}`)
    );
  });

  it("hides and rejects admin tools for a standard API key", async () => {
    const listed = await handleLegacyMcpBody(rpc("tools/list"), server());
    assert.doesNotMatch(JSON.stringify(listed), /create_api_key/);
    const denied = await handleLegacyMcpBody(
      rpc("tools/call", { name: "create_api_key", arguments: {} }),
      server()
    );
    assert.match(JSON.stringify(denied), /"code":-32602/);

    const adminList = await handleLegacyMcpBody(rpc("tools/list"), server(true));
    assert.match(JSON.stringify(adminList), /create_api_key/);
  });

  it("validates tool arguments before execution and binds the calling key", async () => {
    const bad = await handleLegacyMcpBody(
      rpc("tools/call", { name: "get_model", arguments: { id: "model", extra: true } }),
      server()
    );
    assert.match(JSON.stringify(bad), /"code":-32602/);
    const result = await handleLegacyMcpBody(
      rpc("tools/call", { name: "get_model", arguments: { id: "model" } }),
      server()
    );
    assert.match(JSON.stringify(result), /"key_id":"key-1"/);
  });

  it("handles batches and notifications without inventing a response", async () => {
    assert.equal(
      await handleLegacyMcpBody(rpc("notifications/initialized", {}, "notification"), server()),
      null
    );
    const result = await handleLegacyMcpBody(
      JSON.stringify([
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ]),
      server()
    );
    assert.deepEqual(result, [{ jsonrpc: "2.0", id: 2, result: {} }]);
  });

  it("bounds JSON bodies and never exposes an exception stack or credential", async () => {
    const tooLarge = await handleLegacyMcpBody("x".repeat(MAX_LEGACY_MCP_BODY_BYTES + 1), server());
    assert.match(JSON.stringify(tooLarge), /Request body too large/);
    const failed = await handleLegacyMcpBody(
      rpc("tools/call", { name: "failure", arguments: {} }),
      server()
    );
    assert.match(JSON.stringify(failed), /"isError":true/);
    assert.doesNotMatch(JSON.stringify(failed), /private-secret|private\/stack/);
    const known = await handleLegacyMcpBody(
      rpc("tools/call", { name: "known_failure", arguments: {} }),
      server()
    );
    assert.match(JSON.stringify(known), /unknown_model/);
  });
});
