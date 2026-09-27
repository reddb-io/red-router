import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

import {
  handleLegacyMcpHttpRequest,
  type LegacyMcpHttpDependencies,
} from "../../src/lib/mcp/legacyHttp.ts";
import { MAX_LEGACY_MCP_BODY_BYTES } from "../../src/lib/mcp/legacyProtocol.ts";

function request(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/mcp", {
    method: "POST",
    headers: { authorization: "Bearer valid-key", ...headers },
    body,
  });
}

function rpc(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
}

function dependencies(isAdmin = false): LegacyMcpHttpDependencies {
  return {
    appVersion: "test",
    authenticate: async (token) => (token === "valid-key" ? { id: "key-1", isAdmin } : null),
    tools: () => [
      {
        name: "visible_tool",
        description: "Scoped read",
        inputSchema: { type: "object", properties: {} },
        argsSchema: z.object({}).strict(),
        run: async (_args, context) => ({ key_id: context.apiKeyId }),
      },
      {
        name: "admin_tool",
        description: "Admin write",
        inputSchema: { type: "object", properties: {} },
        argsSchema: z.object({}).strict(),
        admin: true,
        run: async () => ({ created: true }),
      },
    ],
  };
}

describe("legacy MCP HTTP boundary", () => {
  it("requires a valid Bearer key even if the client API otherwise allows anonymous calls", async () => {
    const deps = dependencies();
    for (const authorization of ["", "Basic valid-key", "Bearer invalid-key"]) {
      const response = await handleLegacyMcpHttpRequest(
        request(rpc("ping"), { authorization }),
        deps
      );
      assert.equal(response.status, 401);
      assert.match(response.headers.get("www-authenticate") ?? "", /Bearer/);
    }
  });

  it("blocks a foreign browser Origin before authentication", async () => {
    let authenticated = false;
    const deps = dependencies();
    deps.authenticate = async () => {
      authenticated = true;
      return null;
    };
    const response = await handleLegacyMcpHttpRequest(
      request(rpc("ping"), { origin: "https://attacker.example" }),
      deps
    );
    assert.equal(response.status, 403);
    assert.equal(authenticated, false);
  });

  it("scopes tool discovery and execution to the calling key", async () => {
    const ordinary = dependencies();
    const listed = await handleLegacyMcpHttpRequest(request(rpc("tools/list")), ordinary);
    const listBody = await listed.json();
    assert.equal(listed.status, 200);
    assert.match(JSON.stringify(listBody), /visible_tool/);
    assert.doesNotMatch(JSON.stringify(listBody), /admin_tool/);
    assert.equal(listed.headers.get("x-redrouter-mcp-version"), "4");

    const called = await handleLegacyMcpHttpRequest(
      request(rpc("tools/call", { name: "visible_tool", arguments: {} })),
      ordinary
    );
    assert.match(JSON.stringify(await called.json()), /"key_id":"key-1"/);
    const denied = await handleLegacyMcpHttpRequest(
      request(rpc("tools/call", { name: "admin_tool", arguments: {} })),
      ordinary
    );
    assert.doesNotMatch(JSON.stringify(await denied.json()), /"created":true/);

    const admin = await handleLegacyMcpHttpRequest(request(rpc("tools/list")), dependencies(true));
    assert.match(JSON.stringify(await admin.json()), /admin_tool/);
  });

  it("bounds the body and returns 202 for a JSON-RPC notification", async () => {
    const tooLarge = await handleLegacyMcpHttpRequest(
      request("x".repeat(MAX_LEGACY_MCP_BODY_BYTES + 1)),
      dependencies()
    );
    assert.equal(tooLarge.status, 413);

    const notification = await handleLegacyMcpHttpRequest(
      request(JSON.stringify({ jsonrpc: "2.0", method: "ping" })),
      dependencies()
    );
    assert.equal(notification.status, 202);
    assert.equal(await notification.text(), "");
  });

  it("does not expose authentication errors", async () => {
    const deps = dependencies();
    deps.authenticate = async () => {
      throw new Error("private-token at /home/operator/secret.ts:42");
    };
    const response = await handleLegacyMcpHttpRequest(request(rpc("ping")), deps);
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private-token|\/home\/operator/);
  });
});
