// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizeRustProviderOAuth,
  deleteRustClientKey,
  disableRustProvider,
  exchangeRustProviderOAuth,
  extractRustProviderSessionZip,
  importRustProviderSession,
  importRustProviderSessionsBulk,
  issueRustClientKey,
  listRustProviderHealth,
  listRustClientKeys,
  listRustProviderQuotas,
  listRustProviders,
  readRustCatalogProvider,
  readRustModelCatalog,
  readRustUsageSummary,
  readRustAdminCsrfCookie,
  readRustAuthConfig,
  replaceRustClientKey,
  replaceRustProvider,
  refreshRustModelCatalog,
  refreshRustProviderOAuth,
  refreshRustProviderQuota,
  resetRustProviderHealth,
  rotateRustProviderOAuth,
  rustAdminFetch,
  rustProviderOAuthFetch,
  rustProviderSessionFetch,
  rustUsageSinkFetch,
  testRustProvider,
  type RustClientKey,
  type RustProvider,
  type RustProviderQuota,
} from "@/lib/rustControlPlane/browserClient";

const clientKey: RustClientKey = {
  id: "key_fixture",
  label: "Agent fleet",
  tenant_id: "red",
  created_by: "oidc:owner@example.com",
  model_id_format: "prefixed",
  enabled: true,
  expires_at_unix: null,
  scopes: ["inference:chat"],
  allowed_endpoints: ["chat"],
  allowed_models: ["openai/*"],
  blocked_models: [],
  allowed_provider_ids: ["openai-main"],
  max_concurrent_requests: 32,
  max_requests_per_minute: 600,
  max_requests_per_day: null,
  max_tokens_per_minute: 100_000,
  max_tokens_per_day: 1_000_000,
  max_spend_per_month_usd: 25,
  reservation_tokens: 8_192,
  reservation_spend_usd: 1,
  revision: "1700000000000000000",
};

const provider: RustProvider = {
  id: "openrouter-main",
  tenant_id: "red",
  provider: "openai-compatible",
  upstream_url: "https://openrouter.ai/api/v1",
  enabled: true,
  revision: "1700000000000000001",
  has_credential: true,
  rate_limit_scope: "model",
  auth_scheme: "bearer",
  label: "OpenRouter production",
  account_email: "agents@example.com",
  expires_at_unix: 1_900_000_000,
  credential_expired: false,
  credential_type: "static",
  refreshable: false,
  reauth_required: false,
};

const providerQuota: RustProviderQuota = {
  provider_id: "claude-team",
  session: { remaining_percent: 72.5, reset_at_unix_ms: 1_900_000_000_000 },
  weekly: { remaining_percent: 48 },
  limit_reached: false,
  observed_at_unix_ms: 1_800_000_000_000,
  expires_at_unix_ms: 1_800_000_180_000,
  revision: "1700000000000000004",
};

const modelScopedQuota: RustProviderQuota = {
  provider_id: "codex-team",
  models: [
    {
      model_id: "gpt-5.3-codex",
      weekly: { remaining_percent: 64, reset_at_unix_ms: 1_900_000_000_000 },
      limit_reached: false,
      observed_at_unix_ms: 1_800_000_000_000,
      expires_at_unix_ms: 1_800_000_180_000,
      revision: "1700000000000000005",
    },
  ],
  limit_reached: false,
  observed_at_unix_ms: 1_800_000_000_000,
  expires_at_unix_ms: 1_800_000_180_000,
  revision: "1700000000000000006",
};

const catalogManifest = {
  schemaVersion: 1,
  transformVersion: 3,
  source: "https://models.dev/catalog.json?type=all",
  upstreamRepository: "https://github.com/anomalyco/models.dev",
  upstreamSchemaRef: "https://models.dev/schema.json",
  fetchedAt: "2026-11-09T00:00:00.000Z",
  etag: '"fixture"',
  sourceSha256: "a".repeat(64),
  contentSha256: "b".repeat(64),
  license: "MIT",
  providers: 1,
  providerModels: 1,
  canonicalModels: 1,
};

const catalogIndex = {
  manifest: catalogManifest,
  providers: [{ id: "openai", name: "OpenAI" }],
  snapshot: { source: "persisted", revision: "1700000000000000002" },
};

afterEach(() => {
  document.cookie = "redrouter_admin_csrf=; Max-Age=0; Path=/";
  vi.unstubAllGlobals();
});

describe("Rust control-plane browser client", () => {
  it("detects the Rust public auth bootstrap without accepting lookalike payloads", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          backend: "rust",
          control_plane_enabled: true,
          oidc_browser_login: true,
          password_login: false,
        })
      )
      .mockResolvedValueOnce(Response.json({ backend: "rust", oidc_browser_login: true }));
    vi.stubGlobal("fetch", fetch);

    await expect(readRustAuthConfig()).resolves.toMatchObject({ oidc_browser_login: true });
    await expect(readRustAuthConfig()).resolves.toBeNull();
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it("copies the double-submit cookie into same-origin Rust admin requests", async () => {
    document.cookie = "unrelated=1; Path=/";
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    expect(readRustAdminCsrfCookie()).toBe("fixture-token");
    const fetch = vi.fn().mockResolvedValue(Response.json({ providers: [] }));
    vi.stubGlobal("fetch", fetch);

    await rustAdminFetch("/api/admin/providers");
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("x-red-router-csrf")).toBe("fixture-token");
  });

  it("rejects missing sessions and non-admin or cross-origin paths before fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(rustAdminFetch("/api/admin/providers")).rejects.toThrow(
      "Rust admin session is unavailable"
    );
    await expect(rustAdminFetch("https://attacker.example/api/admin/providers")).rejects.toThrow(
      "same-origin"
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("adds the Rust CSRF proof only to same-origin usage-sink paths", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const fetch = vi.fn().mockResolvedValue(Response.json({ sinks: [] }));
    vi.stubGlobal("fetch", fetch);

    await rustUsageSinkFetch("/api/usage-sinks/types");
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("x-red-router-csrf")).toBe("fixture-token");
    await expect(rustUsageSinkFetch("/api/admin/providers")).rejects.toThrow("usage-sinks");
    await expect(rustUsageSinkFetch("https://attacker.example/api/usage-sinks")).rejects.toThrow(
      "same-origin"
    );
  });

  it("keeps provider browser OAuth on the authenticated same-origin Rust surface", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const authorization = {
      authUrl: "https://accounts.example/authorize?state=sealed",
      state: "sealed-state",
      codeVerifier: "v".repeat(43),
      codeChallenge: "c".repeat(43),
      redirectUri: "http://127.0.0.1:20128/callback",
      flowType: "authorization_code" as const,
      callbackPath: "/callback",
      callbackHost: "localhost",
    };
    const connection = {
      id: "agy-account",
      provider: "agy",
      email: "agent@example.com",
      displayName: "Antigravity account",
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(authorization))
      .mockResolvedValueOnce(Response.json({ success: true, connection }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      authorizeRustProviderOAuth("agy", "http://127.0.0.1:20128/callback")
    ).resolves.toEqual(authorization);
    await expect(
      exchangeRustProviderOAuth("agy", {
        code: "authorization-code",
        redirectUri: authorization.redirectUri,
        codeVerifier: authorization.codeVerifier,
        state: authorization.state,
      })
    ).resolves.toEqual(connection);

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/oauth/agy/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A20128%2Fcallback",
      "/api/oauth/agy/exchange",
    ]);
    for (const [, init] of fetch.mock.calls as Array<[string, RequestInit]>) {
      expect(init.credentials).toBe("same-origin");
      expect(new Headers(init.headers).get("x-red-router-csrf")).toBe("fixture-token");
    }
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      code: "authorization-code",
      redirectUri: authorization.redirectUri,
      codeVerifier: authorization.codeVerifier,
      state: authorization.state,
    });

    await expect(
      rustProviderOAuthFetch("https://attacker.example/api/oauth/agy/authorize")
    ).rejects.toThrow("same-origin");
    await expect(rustProviderOAuthFetch("/api/oauth/unknown/authorize")).rejects.toThrow(
      "supported same-origin"
    );
  });

  it("imports provider sessions through the authenticated Rust authority", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const importedProvider: RustProvider = {
      ...provider,
      id: "codex-account",
      provider: "codex",
      credential_type: "oauth",
      oauth_provider: "codex",
      oauth_generation: "1",
      refreshable: true,
      oauth_refresh_state: "ready",
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ connection: importedProvider, created: true }, { status: 201 })
      )
      .mockResolvedValueOnce(Response.json({ success: 2, failed: 0, total: 2, errors: [] }))
      .mockResolvedValueOnce(
        Response.json({
          entries: [{ name: "auth.json", json: { tokens: {} }, parseError: null }],
        })
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      importRustProviderSession(
        "codex",
        { json: { tokens: { access_token: "write-only" } }, name: "Work" },
        false
      )
    ).resolves.toMatchObject({ created: true, connection: { id: "codex-account" } });
    await expect(
      importRustProviderSessionsBulk(
        "claude",
        [{ json: { claudeAiOauth: {} } }, { json: { claudeAiOauth: {} } }],
        true
      )
    ).resolves.toMatchObject({ success: 2, total: 2 });
    await expect(extractRustProviderSessionZip("agy", new Blob(["zip-fixture"]))).resolves.toEqual([
      { name: "auth.json", json: { tokens: {} }, parseError: null },
    ]);

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/providers/codex-auth/import",
      "/api/providers/claude-auth/import-bulk",
      "/api/providers/agy-auth/zip-extract",
    ]);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      source: { kind: "json", json: { tokens: { access_token: "write-only" } } },
      name: "Work",
      overwriteExisting: false,
    });
    for (const [, init] of fetch.mock.calls as Array<[string, RequestInit]>) {
      expect(init.credentials).toBe("same-origin");
      expect(new Headers(init.headers).get("x-red-router-csrf")).toBe("fixture-token");
    }
    await expect(
      rustProviderSessionFetch("https://attacker.example/api/providers/codex-auth/import")
    ).rejects.toThrow("same-origin");
  });

  it("uses the Rust key authority for list, issue, replacement and revocation", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ client_keys: [clientKey] }))
      .mockResolvedValueOnce(
        Response.json(
          { client_key: clientKey, key: "rrk_one-time-secret", warning: "Store it" },
          { status: 201 }
        )
      )
      .mockResolvedValueOnce(Response.json({ client_key: { ...clientKey, enabled: false } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await expect(listRustClientKeys()).resolves.toEqual([clientKey]);
    const input = {
      ...clientKey,
      expires_at_unix: undefined,
    };
    delete (input as Partial<RustClientKey>).id;
    delete (input as Partial<RustClientKey>).created_by;
    delete (input as Partial<RustClientKey>).revision;
    await expect(issueRustClientKey(input)).resolves.toMatchObject({
      key: "rrk_one-time-secret",
    });
    await expect(replaceRustClientKey(clientKey.id, input)).resolves.toMatchObject({
      enabled: false,
    });
    await expect(deleteRustClientKey(clientKey.id)).resolves.toBeUndefined();

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/admin/client-keys",
      "/api/admin/client-keys",
      "/api/admin/client-keys/key_fixture",
      "/api/admin/client-keys/key_fixture",
    ]);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({ method: "PUT" });
    expect(fetch.mock.calls[3]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("uses the Rust provider authority without accepting returned credentials", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ providers: [provider] }))
      .mockResolvedValueOnce(Response.json({ provider }))
      .mockResolvedValueOnce(
        Response.json({
          diagnostic: {
            provider_id: provider.id,
            model: "openai/gpt-5",
            ok: true,
            category: "ok",
            upstream_status: 200,
            latency_ms: 18,
          },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({ providers: [{ ...provider, api_key: "must-not-leak" }] })
      );
    vi.stubGlobal("fetch", fetch);

    await expect(listRustProviders()).resolves.toEqual([provider]);
    await expect(
      replaceRustProvider(provider.id, {
        provider: provider.provider,
        upstream_url: provider.upstream_url,
        api_key: "write-only-secret",
        enabled: true,
        rate_limit_scope: "model",
        auth_scheme: "bearer",
        label: "OpenRouter production",
        account_email: "agents@example.com",
        expires_at_unix: 1_900_000_000,
      })
    ).resolves.toEqual(provider);
    await expect(testRustProvider(provider.id, "openai/gpt-5")).resolves.toMatchObject({
      ok: true,
      upstream_status: 200,
    });
    await expect(disableRustProvider(provider.id)).resolves.toBeUndefined();
    await expect(listRustProviders()).rejects.toThrow("Invalid Rust provider response");

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/admin/providers",
      "/api/admin/providers/openrouter-main",
      "/api/admin/providers/openrouter-main/test",
      "/api/admin/providers/openrouter-main",
      "/api/admin/providers",
    ]);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "PUT" });
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
    expect(fetch.mock.calls[3]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("rotates OAuth credentials with a generation and keeps both tokens write-only", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const oauthProvider: RustProvider = {
      ...provider,
      id: "claude-team",
      provider: "claude",
      credential_type: "oauth",
      oauth_provider: "claude",
      oauth_generation: "4",
      refreshable: true,
      oauth_refresh_state: "ready",
      reauth_required: false,
    };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ provider: oauthProvider }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      rotateRustProviderOAuth(oauthProvider.id, {
        expected_generation: "3",
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_at_unix: 1_900_000_000,
      })
    ).resolves.toEqual(oauthProvider);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/admin/providers/claude-team/oauth/rotate");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      expected_generation: "3",
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_at_unix: 1_900_000_000,
    });
  });

  it("requests a server-owned OAuth refresh without exposing either token", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const refresh = {
      provider_id: "claude-team",
      ok: true,
      category: "refreshed",
      generation: "5",
      expires_at_unix: 1_900_000_000,
    };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ refresh }));
    vi.stubGlobal("fetch", fetch);

    await expect(refreshRustProviderOAuth("claude-team")).resolves.toEqual(refresh);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/admin/providers/claude-team/oauth/refresh");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: "{}" });
    expect(String(fetch.mock.calls[0]?.[1]?.body)).not.toContain("token");
  });

  it("reads and refreshes provider quota snapshots without accepting credential fields", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ provider_quotas: [providerQuota, modelScopedQuota] }))
      .mockResolvedValueOnce(
        Response.json({
          refresh: {
            provider_id: providerQuota.provider_id,
            refreshed: true,
            category: "refreshed",
            quota: providerQuota,
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          provider_quotas: [{ ...providerQuota, access_token: "must-not-leak" }],
        })
      );
    vi.stubGlobal("fetch", fetch);

    await expect(listRustProviderQuotas()).resolves.toEqual([providerQuota, modelScopedQuota]);
    await expect(refreshRustProviderQuota(providerQuota.provider_id)).resolves.toMatchObject({
      refreshed: true,
      quota: providerQuota,
    });
    await expect(listRustProviderQuotas()).rejects.toThrow("Invalid Rust provider quota response");

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/admin/provider-quotas",
      "/api/admin/provider-quotas/claude-team/refresh",
      "/api/admin/provider-quotas",
    ]);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(fetch.mock.calls[1]?.[1]?.body).toBeUndefined();
  });

  it("reads and resets durable provider health without exposing credentials", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const health = {
      provider_id: "claude-team",
      state: "open",
      failure_count: 5,
      retry_after_ms: 12_000,
      open_cycle_count: 2,
      failure_threshold: 5,
      degradation_threshold: 3,
      reset_timeout_ms: 30_000,
      connection_cooldown_until_unix_ms: 9_223_372_036_854_776_000,
      connection_retry_after_ms: 9_223_370_136_854_776_000,
      connection_backoff_level: 2,
      connection_last_status: 429,
      terminal_status: "banned",
      ambiguous_auth_strikes: 1,
      ambiguous_auth_retry_limit: 3,
      model_lockouts: [
        {
          model: "claude-opus-4-1",
          status: 429,
          until_unix_ms: 1_900_000_000_000,
          retry_after_ms: 8_000,
          backoff_level: 2,
        },
      ],
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ provider_health: [health] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await expect(listRustProviderHealth()).resolves.toEqual([health]);
    await expect(resetRustProviderHealth(health.provider_id)).resolves.toBeUndefined();
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/admin/provider-health",
      "/api/admin/provider-health/claude-team",
    ]);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("reads and refreshes the validated models.dev catalog through Rust", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const catalogProvider = {
      id: "openai",
      name: "OpenAI",
      models: [
        {
          id: "gpt-5",
          name: "GPT-5",
          reasoning: true,
          tool_call: true,
          limit: { context: 400_000, output: 128_000 },
        },
      ],
    };
    const refresh = {
      changed: true,
      source: "persisted",
      revision: "1700000000000000003",
      manifest: catalogManifest,
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(catalogIndex))
      .mockResolvedValueOnce(Response.json({ provider: catalogProvider }))
      .mockResolvedValueOnce(Response.json({ snapshot: refresh }))
      .mockResolvedValueOnce(
        Response.json({ ...catalogIndex, manifest: { ...catalogManifest, providers: -1 } })
      );
    vi.stubGlobal("fetch", fetch);

    await expect(readRustModelCatalog()).resolves.toEqual(catalogIndex);
    await expect(readRustCatalogProvider("openai")).resolves.toEqual(catalogProvider);
    await expect(refreshRustModelCatalog()).resolves.toEqual(refresh);
    await expect(readRustModelCatalog()).rejects.toThrow("Invalid Rust model catalog response");

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/admin/model-catalog",
      "/api/admin/model-catalog/openai",
      "/api/admin/model-catalog/refresh",
      "/api/admin/model-catalog",
    ]);
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
  });

  it("reads bounded Rust usage totals without accepting partial payloads", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const usage = {
      request_count: 7,
      priced_request_count: 6,
      tokens_input: 100,
      tokens_output: 50,
      tokens_cache_read: 20,
      tokens_cache_creation: 10,
      tokens_reasoning: 5,
      amount_microusd: 1234,
      pending_request_count: 2,
      pending_reserved_tokens: 4096,
      pending_reserved_microusd: 50_000,
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ usage }))
      .mockResolvedValueOnce(Response.json({ usage: { request_count: 1 } }));
    vi.stubGlobal("fetch", fetch);

    await expect(readRustUsageSummary("key_fixture")).resolves.toEqual(usage);
    await expect(readRustUsageSummary()).rejects.toThrow("Invalid Rust usage response");
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/admin/usage?key_id=key_fixture&limit=1");
  });
});
