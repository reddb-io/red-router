import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createLegacyCreateKeyTool,
  machineIdForLegacyKey,
  type LegacyCreateKeyStore,
} from "../../src/lib/mcp/legacyCreateKeyTool.ts";
import { handleLegacyMcpBody, type LegacyMcpServer } from "../../src/lib/mcp/legacyProtocol.ts";

function server(isAdmin: boolean, store: LegacyCreateKeyStore): LegacyMcpServer {
  return {
    info: { name: "red-router", version: "test" },
    context: { apiKeyId: "admin-key", isAdmin },
    tools: [createLegacyCreateKeyTool(store)],
  };
}

function call(args: Record<string, unknown>) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "create_api_key", arguments: args },
  });
}

describe("legacy MCP API-key creation", () => {
  it("uses the persisted caller machine ID or a non-spawning random fallback", () => {
    assert.equal(machineIdForLegacyKey("ABCDEF0123456789"), "abcdef0123456789");
    const fallback = machineIdForLegacyKey(null);
    assert.match(fallback, /^[0-9a-f]{16}$/);
    assert.notEqual(fallback, machineIdForLegacyKey(null));
    assert.match(machineIdForLegacyKey("host-name-with-dashes"), /^[0-9a-f]{16}$/);
  });
  it("hides creation from ordinary keys", async () => {
    let created = false;
    const store: LegacyCreateKeyStore = {
      create: async () => {
        created = true;
        throw new Error("must not create");
      },
    };
    const listed = await handleLegacyMcpBody(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      server(false, store)
    );
    assert.doesNotMatch(JSON.stringify(listed), /create_api_key/);
    const denied = await handleLegacyMcpBody(call({ name: "Client" }), server(false, store));
    assert.match(JSON.stringify(denied), /"code":-32602/);
    assert.equal(created, false);
  });

  it("creates a standard key with normalized tags, limits and flat preference", async () => {
    let received: Parameters<LegacyCreateKeyStore["create"]>[0] | null = null;
    let receivedMachineId: string | null | undefined;
    const store: LegacyCreateKeyStore = {
      create: async (args, context) => {
        received = args;
        receivedMachineId = context.apiKeyMachineId;
        return {
          id: "created-id",
          name: args.name,
          key: "omni_private-secret",
          createdAt: "2026-09-27T00:00:00.000Z",
        } as never;
      },
    };
    const result = await handleLegacyMcpBody(
      call({
        name: " Client ",
        tags: [" Team-A ", "team-a", "production"],
        limits: { rpm: 5, tokensPerDay: 100, usdPerMonth: 2.5 },
        id_format: "flat",
      }),
      {
        ...server(true, store),
        context: {
          apiKeyId: "admin-key",
          isAdmin: true,
          apiKeyMachineId: "abcdef0123456789",
        },
      }
    );
    assert.equal(receivedMachineId, "abcdef0123456789");
    assert.deepEqual(received, {
      name: "Client",
      tags: ["Team-A", "production"],
      limits: { rpm: 5, tokensPerDay: 100, usdPerMonth: 2.5 },
      id_format: "flat",
    });
    const serialized = JSON.stringify(result);
    assert.match(serialized, /"id_format":"flat"/);
    assert.match(serialized, /"role":"standard"/);
    assert.match(serialized, /"key":"omni_private-secret"/);
  });

  it("rejects malformed input before creating a key", async () => {
    let created = false;
    const store: LegacyCreateKeyStore = {
      create: async () => {
        created = true;
        throw new Error("must not create");
      },
    };
    for (const args of [
      { name: " " },
      { name: "Client", tags: [42] },
      { name: "Client", limits: { rpm: 0 } },
      { name: "Client", id_format: "other" },
    ]) {
      const result = await handleLegacyMcpBody(call(args), server(true, store));
      assert.match(JSON.stringify(result), /"code":-32602/);
    }
    assert.equal(created, false);
  });

  it("sanitizes unexpected creation failures", async () => {
    const store: LegacyCreateKeyStore = {
      create: async () => {
        throw new Error("private-token at /home/operator/secret.ts:42");
      },
    };
    const result = await handleLegacyMcpBody(call({ name: "Client" }), server(true, store));
    const serialized = JSON.stringify(result);
    assert.match(serialized, /"isError":true/);
    assert.doesNotMatch(serialized, /private-token|\/home\/operator/);
  });
});
