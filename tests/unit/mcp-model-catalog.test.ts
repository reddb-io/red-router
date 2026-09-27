import test from "node:test";
import assert from "node:assert/strict";

import { getMcpModelsCatalog } from "../../open-sse/mcp-server/server.ts";
import { clearAllModelLockouts, lockModel } from "../../open-sse/services/accountFallback.ts";
import { __clearForTests, setQuotaCache } from "../../src/domain/quotaCache.ts";

test("getMcpModelsCatalog aggregates only active connection model endpoints", async () => {
  const calls: string[] = [];

  const result = await getMcpModelsCatalog(
    {},
    {
      listProviderConnections: async () => [
        { id: "conn-github", provider: "github", isActive: true },
        { id: "conn-codex", provider: "codex", isActive: false },
      ],
      fetchJson: async (path: string) => {
        calls.push(path);
        if (path === "/api/providers/conn-github/models?excludeHidden=true") {
          return {
            source: "api",
            models: [
              { id: "gpt-4.1", owned_by: "github", supportedEndpoints: ["chat"] },
              {
                id: "text-embedding-3-small",
                owned_by: "github",
                supportedEndpoints: ["embeddings"],
              },
            ],
          };
        }

        throw new Error(`Unexpected path: ${path}`);
      },
    }
  );

  assert.deepEqual(calls, ["/api/providers/conn-github/models?excludeHidden=true"]);
  assert.deepEqual(result, {
    models: [
      {
        id: "gpt-4.1",
        provider: "github",
        capabilities: ["chat"],
        status: "available",
        accounts: { available: 1, total: 1 },
        pricing: undefined,
      },
      {
        id: "text-embedding-3-small",
        provider: "github",
        capabilities: ["embedding"],
        status: "available",
        accounts: { available: 1, total: 1 },
        pricing: undefined,
      },
    ],
    source: "api",
  });
});

test("getMcpModelsCatalog does not label quota-exhausted models available", async () => {
  __clearForTests();
  setQuotaCache("mcp-quota-a", "openai", {
    daily: { remainingPercentage: 0, resetAt: new Date(Date.now() + 60_000).toISOString() },
  });
  try {
    const result = await getMcpModelsCatalog(
      { provider: "openai" },
      {
        listProviderConnections: async () => [
          { id: "mcp-quota-a", provider: "openai", isActive: true },
        ],
        fetchJson: async () => ({ source: "api", models: [{ id: "gpt-4.1" }] }),
      }
    );
    assert.equal(result.models[0]?.status, "unavailable");
    assert.equal(result.models[0]?.unavailableReason, "quota_exhausted");
    assert.deepEqual(result.models[0]?.accounts, { available: 0, total: 1 });
  } finally {
    __clearForTests();
  }
});

test("getMcpModelsCatalog keeps a model available when another account is unlocked", async () => {
  clearAllModelLockouts();
  lockModel("openai", "mcp-lock-a", "gpt-4.1", "quota_exhausted", 60_000);
  try {
    const result = await getMcpModelsCatalog(
      { provider: "openai" },
      {
        listProviderConnections: async () => [
          { id: "mcp-lock-a", provider: "openai", isActive: true },
          { id: "mcp-lock-b", provider: "openai", isActive: true },
        ],
        fetchJson: async () => ({ source: "api", models: [{ id: "gpt-4.1" }] }),
      }
    );
    assert.equal(result.models[0]?.status, "available");
    assert.equal(result.models[0]?.unavailableReason, undefined);
    assert.deepEqual(result.models[0]?.accounts, { available: 1, total: 2 });
  } finally {
    clearAllModelLockouts();
  }
});

test("getMcpModelsCatalog reports a locked model and an independent healthy model", async () => {
  clearAllModelLockouts();
  lockModel("openai", "mcp-lock-only", "gpt-4.1", "quota_exhausted", 60_000);
  try {
    const result = await getMcpModelsCatalog(
      { provider: "openai" },
      {
        listProviderConnections: async () => [
          { id: "mcp-lock-only", provider: "openai", isActive: true },
        ],
        fetchJson: async () => ({
          source: "api",
          models: [{ id: "gpt-4.1" }, { id: "gpt-4o" }],
        }),
      }
    );
    const locked = result.models.find((model) => model.id === "gpt-4.1");
    const healthy = result.models.find((model) => model.id === "gpt-4o");
    assert.equal(locked?.status, "unavailable");
    assert.equal(locked?.unavailableReason, "quota_exhausted");
    assert.deepEqual(locked?.accounts, { available: 0, total: 1 });
    assert.equal(healthy?.status, "available");
  } finally {
    clearAllModelLockouts();
  }
});

test("getMcpModelsCatalog marks a cooling connection unavailable", async () => {
  const result = await getMcpModelsCatalog(
    { provider: "openai" },
    {
      listProviderConnections: async () => [
        {
          id: "mcp-cooldown-only",
          provider: "openai",
          isActive: true,
          rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      fetchJson: async () => ({ source: "api", models: [{ id: "gpt-4.1" }] }),
    }
  );
  assert.equal(result.models[0]?.status, "unavailable");
  assert.equal(result.models[0]?.unavailableReason, "rate_limited");
});

test("getMcpModelsCatalog exposes codex default thinking effort when no override is stored", async () => {
  const result = await getMcpModelsCatalog(
    { provider: "codex" },
    {
      listProviderConnections: async () => [
        {
          id: "conn-codex",
          provider: "codex",
          isActive: true,
          providerSpecificData: {},
        },
      ],
      fetchJson: async () => ({
        source: "api",
        models: [{ id: "gpt-5.5", owned_by: "codex", supportedEndpoints: ["chat"] }],
      }),
    }
  );

  assert.equal(result.models.length, 1);
  assert.equal(result.models[0]?.thinkingEffort, "medium");
});

// #12776 — context_length must be carried through the MCP catalog projection
test("getMcpModelsCatalog includes context_length when present", async () => {
  const result = await getMcpModelsCatalog(
    {},
    {
      listProviderConnections: async () => [{ id: "conn-1", provider: "openai", isActive: true }],
      fetchJson: async () => ({
        source: "api",
        models: [
          { id: "gpt-4.1", owned_by: "openai", context_length: 1048576 },
          { id: "text-embedding-3-small", owned_by: "openai" },
        ],
      }),
    }
  );

  const gpt = result.models.find((m) => m.id === "gpt-4.1");
  const emb = result.models.find((m) => m.id === "text-embedding-3-small");

  assert.equal(gpt?.context_length, 1048576, "context_length carried from upstream");
  assert.equal(emb?.context_length, undefined, "omitted when upstream has no context_length");
});

test("getMcpModelsCatalog exposes stored thinking effort overrides", async () => {
  const result = await getMcpModelsCatalog(
    { provider: "gemini-web" },
    {
      listProviderConnections: async () => [
        {
          id: "conn-gemini-web",
          provider: "gemini-web",
          isActive: true,
          providerSpecificData: { thinkingEffort: "extended" },
        },
      ],
      fetchJson: async () => ({
        source: "api",
        models: [{ id: "gemini-3.1-pro", owned_by: "gemini-web", supportedEndpoints: ["chat"] }],
      }),
    }
  );

  assert.equal(result.models.length, 1);
  assert.equal(result.models[0]?.thinkingEffort, "extended");
});

test("getMcpModelsCatalog resolves provider aliases to active connection ids", async () => {
  const calls: string[] = [];

  const result = await getMcpModelsCatalog(
    { provider: "gh", capability: "chat" },
    {
      listProviderConnections: async () => [
        { id: "conn-github", provider: "github", isActive: true },
        { id: "conn-codex", provider: "codex", isActive: true },
      ],
      fetchJson: async (path: string) => {
        calls.push(path);
        return {
          source: "api",
          models: [{ id: "gpt-4.1", owned_by: "github", supportedEndpoints: ["chat"] }],
        };
      },
    }
  );

  assert.deepEqual(calls, ["/api/providers/conn-github/models?excludeHidden=true"]);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0]?.provider, "github");
  assert.deepEqual(result.models[0]?.capabilities, ["chat"]);
});

test("getMcpModelsCatalog returns empty result when requested provider has no active connection", async () => {
  const result = await getMcpModelsCatalog(
    { provider: "github" },
    {
      listProviderConnections: async () => [
        { id: "conn-codex", provider: "codex", isActive: true },
      ],
      fetchJson: async () => {
        throw new Error("fetchJson should not be called without a matching active provider");
      },
    }
  );

  assert.deepEqual(result, {
    models: [],
    source: "provider_connections",
    warning: "No active connections found for provider 'github'.",
  });
});
