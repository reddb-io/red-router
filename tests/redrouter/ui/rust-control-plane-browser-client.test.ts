// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizeRustProviderOAuth,
  clearRustComboRoutePin,
  clearRustProviderQuota,
  configureRustProviderHealth,
  configureRustProviderQuota,
  createRustAdminSession,
  deleteRustClientKey,
  deleteRustIdentityBinding,
  deleteRustTokenLimit,
  disableRustCombo,
  disableRustProvider,
  exchangeRustProviderOAuth,
  extractRustProviderSessionZip,
  importRustProviderSession,
  importRustProviderSessionsBulk,
  issueRustClientKey,
  listRustAuditEvents,
  listRustCombos,
  listRustProviderHealth,
  listRustClientKeys,
  listRustIdentityBindings,
  listRustTokenLimits,
  listRustProviderQuotas,
  listRustProviders,
  listRustTenants,
  readRustCatalogProvider,
  readRustModelCatalog,
  readRustRuntimeStatus,
  readRustUsageSummary,
  readRustAdminCsrfCookie,
  readRustAuthConfig,
  replaceRustClientKey,
  replaceRustIdentityBinding,
  replaceRustTenant,
  replaceRustCombo,
  replaceRustProvider,
  refreshRustModelCatalog,
  refreshRustProviderOAuth,
  refreshRustProviderQuota,
  resetRustProviderHealth,
  rotateRustProviderOAuth,
  rustAdminFetch,
  rustProviderOAuthFetch,
  rustProviderSessionFetch,
  rustTokenLimitFetch,
  rustUsageSinkFetch,
  saveRustTokenLimit,
  testRustProvider,
  type RustClientKey,
  type RustCombo,
  type RustAuditEvent,
  type RustIdentityBinding,
  type RustProvider,
  type RustProviderQuota,
  type RustTenant,
  type RustTokenLimit,
} from "@/lib/rustControlPlane/browserClient";

const clientKey: RustClientKey = {
  id: "key_fixture",
  label: "Agent fleet",
  tenant_id: "red",
  created_by: "oidc:owner@example.com",
  model_id_format: "prefixed",
  model_access_mode: "restricted",
  allowed_combos: null,
  enabled: true,
  expires_at_unix: null,
  access_schedule: {
    enabled: true,
    from: "08:00",
    until: "18:00",
    days: [1, 2, 3, 4, 5],
    tz: "America/Sao_Paulo",
  },
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

const tokenLimit: RustTokenLimit = {
  id: "limit-fixture",
  apiKeyId: clientKey.id,
  scopeType: "model",
  scopeValue: "openai/gpt-5",
  tokenLimit: 100_000,
  resetInterval: "daily",
  resetTime: "02:30",
  enabled: true,
  tokensUsed: 12_000,
  windowStart: "1800000000000",
  periodStartAt: 1_800_000_000_000,
  nextResetAt: 1_800_086_400_000,
  remaining: 88_000,
};

const tenant: RustTenant = {
  id: "acme",
  slug: "acme",
  name: "Acme",
  enabled: true,
  revision: "1700000000000000002",
};

const identityBinding: RustIdentityBinding = {
  id: "acme-manager",
  subject: "oidc:v1:fixture",
  tenant_id: tenant.id,
  role: "tenant-admin",
  enabled: true,
  revision: "1700000000000000003",
};

const auditEvent: RustAuditEvent = {
  id: "audit-fixture",
  timestamp: "2026-11-11T20:00:00Z",
  createdAt: "2026-11-11T20:00:00Z",
  action: "provider.update",
  actor: "oidc:fixture",
  tenantId: tenant.id,
  target: "openrouter-main",
  resourceType: "provider",
  status: "success",
  requestId: "request-fixture",
  details: { enabled: true },
  metadata: { enabled: true },
  ip: null,
  ipAddress: null,
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

const githubCopilotProvider: RustProvider = {
  ...provider,
  id: "github-copilot",
  provider: "github",
  upstream_url: "https://api.githubcopilot.com/chat/completions",
  credential_type: "oauth",
  oauth_provider: "github",
  oauth_generation: "2",
  refreshable: true,
};

const xaiOAuthProvider: RustProvider = {
  ...provider,
  id: "xai-oauth",
  provider: "xai-oauth",
  upstream_url: "https://api.x.ai/v1/chat/completions",
  credential_type: "oauth",
  oauth_provider: "xai-oauth",
  oauth_generation: "3",
  refreshable: true,
};

const openferenceProvider: RustProvider = {
  ...provider,
  id: "openference",
  provider: "openference",
  upstream_url: "https://api.openference.com/v1/chat/completions",
  credential_type: "oauth",
  oauth_provider: "openference",
  oauth_generation: "4",
  refreshable: true,
};

const combo: RustCombo = {
  id: "agent-route",
  tenant_id: "red",
  protocol: "openai",
  strategy: "auto",
  fallback: true,
  targets: [{ provider_id: provider.id, model: "openai/gpt-5", context_window_tokens: 400_000 }],
  auto: { weights: { quota: 0.3, cost: 0.25, context: 0.15, load: 0.3 } },
  enabled: true,
  revision: "1700000000000000003",
  last_known_good: {
    provider_id: provider.id,
    model: "openai/gpt-5",
    revision: "1700000000000000002",
  },
};

const fusionCombo: RustCombo = {
  ...combo,
  id: "review-panel",
  strategy: "fusion",
  targets: [
    { provider_id: provider.id, model: "openai/gpt-5" },
    { provider_id: provider.id, model: "anthropic/claude-sonnet-4.5" },
  ],
  auto: undefined,
  fusion: {
    judgeModel: `${provider.id}/openai/gpt-5`,
    minPanel: 2,
    stragglerGraceMs: 8_000,
    panelTimeoutMs: 90_000,
  },
  last_known_good: undefined,
};

const pipelineCombo: RustCombo = {
  ...combo,
  id: "coding-pipeline",
  strategy: "pipeline",
  targets: [
    {
      provider_id: provider.id,
      model: "openai/gpt-5",
      prompt: "Review the proposed implementation.",
    },
    { provider_id: provider.id, model: "openai/gpt-5-mini" },
  ],
  auto: undefined,
  pipeline: { maxRetries: 2, retryDelayMs: 500 },
  last_known_good: undefined,
};

const nestedCombo: RustCombo = {
  ...combo,
  id: "nested-route",
  strategy: "priority",
  targets: [{ kind: "combo-ref", combo_id: combo.id }],
  auto: undefined,
  last_known_good: undefined,
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
  it("reads liveness and readiness from the Rust runtime without cached responses", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);

    await expect(readRustRuntimeStatus()).resolves.toMatchObject({ live: true, ready: false });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/healthz", "/readyz"]);
    for (const [, init] of fetch.mock.calls as Array<[string, RequestInit]>) {
      expect(init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
    }
  });

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

  it("creates a same-origin Rust administrator session without retaining the key", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const adminKey = "a".repeat(32);

    await expect(createRustAdminSession("short")).rejects.toThrow("between 32 and 512");
    expect(fetch).not.toHaveBeenCalled();
    await createRustAdminSession(adminKey);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [path, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/auth/local/login");
    expect(init).toMatchObject({ method: "POST", cache: "no-store", credentials: "same-origin" });
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ admin_key: adminKey });
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
      "admin session is unavailable"
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

  it("uses the Rust browser OAuth surface for xAI without exposing tokens", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const authorization = {
      authUrl: "https://auth.x.ai/oauth2/authorize?state=sealed",
      state: "sealed-xai-state",
      codeVerifier: "v".repeat(43),
      codeChallenge: "c".repeat(43),
      redirectUri: "http://127.0.0.1:56121/callback",
      flowType: "authorization_code_pkce" as const,
      callbackPath: "/callback",
      callbackHost: "127.0.0.1",
      fixedPort: 56121,
    };
    const connection = {
      id: "xai-fixture",
      provider: "xai-oauth" as const,
      email: "agent@example.com",
      displayName: "xAI OAuth",
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(authorization))
      .mockResolvedValueOnce(Response.json({ success: true, connection }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      authorizeRustProviderOAuth("xai-oauth", authorization.redirectUri)
    ).resolves.toEqual(authorization);
    await expect(
      exchangeRustProviderOAuth("xai-oauth", {
        code: "authorization-code",
        redirectUri: authorization.redirectUri,
        codeVerifier: authorization.codeVerifier,
        state: authorization.state,
      })
    ).resolves.toEqual(connection);

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/oauth/xai-oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A56121%2Fcallback",
      "/api/oauth/xai-oauth/exchange",
    ]);
    expect(String(fetch.mock.calls[1]?.[1]?.body)).not.toContain("access_token");
    expect(String(fetch.mock.calls[1]?.[1]?.body)).not.toContain("refresh_token");
  });

  it("uses the Rust browser OAuth surface for Openference without exposing tokens", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const authorization = {
      authUrl: "https://openference.com/app/oauth/authorize?state=sealed",
      state: "sealed-openference-state",
      codeVerifier: "v".repeat(43),
      codeChallenge: "c".repeat(43),
      redirectUri: "http://127.0.0.1:56123/callback",
      flowType: "authorization_code_pkce" as const,
      callbackPath: "/callback",
      callbackHost: "127.0.0.1",
      fixedPort: 56123,
    };
    const connection = {
      id: "openference-fixture",
      provider: "openference" as const,
      email: "agent@example.com",
      displayName: "Openference",
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(authorization))
      .mockResolvedValueOnce(Response.json({ success: true, connection }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      authorizeRustProviderOAuth("openference", authorization.redirectUri)
    ).resolves.toEqual(authorization);
    await expect(
      exchangeRustProviderOAuth("openference", {
        code: "authorization-code",
        redirectUri: authorization.redirectUri,
        codeVerifier: authorization.codeVerifier,
        state: authorization.state,
      })
    ).resolves.toEqual(connection);

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/oauth/openference/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A56123%2Fcallback",
      "/api/oauth/openference/exchange",
    ]);
    expect(String(fetch.mock.calls[1]?.[1]?.body)).not.toContain("access_token");
    expect(String(fetch.mock.calls[1]?.[1]?.body)).not.toContain("refresh_token");
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

  it("preserves restricted empty model lists and rejects unknown access modes", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const restricted = { ...clientKey, allowed_models: [], model_access_mode: "restricted" };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ client_keys: [restricted] }))
        .mockResolvedValueOnce(
          Response.json({ client_keys: [{ ...restricted, model_access_mode: "typo" }] })
        )
    );
    await expect(listRustClientKeys()).resolves.toEqual([restricted]);
    await expect(listRustClientKeys()).rejects.toThrow("Invalid client-key");
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

  it("manages organizations and OIDC identity bindings through the global Rust authority", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ tenants: [tenant] }))
      .mockResolvedValueOnce(Response.json({ tenant: { ...tenant, name: "Acme Cloud" } }))
      .mockResolvedValueOnce(Response.json({ identity_bindings: [identityBinding] }))
      .mockResolvedValueOnce(
        Response.json({ identity_binding: { ...identityBinding, role: "issuer" } })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await expect(listRustTenants()).resolves.toEqual([tenant]);
    await expect(
      replaceRustTenant(tenant.id, { slug: tenant.slug, name: "Acme Cloud", enabled: true })
    ).resolves.toMatchObject({ name: "Acme Cloud" });
    await expect(listRustIdentityBindings()).resolves.toEqual([identityBinding]);
    await expect(
      replaceRustIdentityBinding(identityBinding.id, {
        subject: identityBinding.subject,
        tenant_id: tenant.id,
        role: "issuer",
        enabled: true,
      })
    ).resolves.toMatchObject({ role: "issuer" });
    await expect(deleteRustIdentityBinding(identityBinding.id)).resolves.toBeUndefined();

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/admin/tenants",
      "/api/admin/tenants/acme",
      "/api/admin/identity-bindings",
      "/api/admin/identity-bindings/acme-manager",
      "/api/admin/identity-bindings/acme-manager",
    ]);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      slug: "acme",
      name: "Acme Cloud",
      enabled: true,
    });
    expect(fetch.mock.calls[3]?.[1]).toMatchObject({ method: "PUT" });
    expect(fetch.mock.calls[4]?.[1]).toMatchObject({ method: "DELETE" });
    for (const [, init] of fetch.mock.calls as Array<[string, RequestInit]>) {
      expect(new Headers(init.headers).get("x-red-router-csrf")).toBe("fixture-token");
    }
  });

  it("rejects malformed organization and identity-binding responses", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ tenants: [{ ...tenant, extra: "unexpected" }] }))
      .mockResolvedValueOnce(
        Response.json({ identity_bindings: [{ ...identityBinding, role: "owner" }] })
      );
    vi.stubGlobal("fetch", fetch);

    await expect(listRustTenants()).rejects.toThrow("Invalid tenant response");
    await expect(listRustIdentityBindings()).rejects.toThrow("Invalid identity-binding response");
  });

  it("reads a bounded, filterable Rust audit page and validates its total", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([auditEvent]), {
          status: 200,
          headers: { "content-type": "application/json", "x-total-count": "1" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([auditEvent]), {
          status: 200,
          headers: { "content-type": "application/json", "x-total-count": "invalid" },
        })
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      listRustAuditEvents({
        action: auditEvent.action,
        resourceType: auditEvent.resourceType,
        limit: 50,
        offset: 0,
      })
    ).resolves.toEqual({ events: [auditEvent], total: 1 });
    await expect(listRustAuditEvents()).rejects.toThrow("Invalid audit-log total");
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/api/admin/audit-log?action=provider.update&resourceType=provider&limit=50&offset=0"
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-red-router-csrf")).toBe(
      "fixture-token"
    );
  });

  it("manages per-model token limits through the authenticated Rust compatibility route", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ apiKeyId: clientKey.id, limits: [tokenLimit] }))
      .mockResolvedValueOnce(Response.json({ success: true, limit: tokenLimit }))
      .mockResolvedValueOnce(Response.json({ success: true }));
    vi.stubGlobal("fetch", fetch);

    await expect(listRustTokenLimits(clientKey.id)).resolves.toEqual([tokenLimit]);
    await expect(
      saveRustTokenLimit({
        apiKeyId: clientKey.id,
        scopeType: "model",
        scopeValue: tokenLimit.scopeValue,
        tokenLimit: tokenLimit.tokenLimit,
        resetInterval: "daily",
        resetTime: "02:30",
        enabled: true,
      })
    ).resolves.toEqual(tokenLimit);
    await expect(deleteRustTokenLimit(tokenLimit.id)).resolves.toBeUndefined();

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/usage/token-limits?apiKeyId=key_fixture",
      "/api/usage/token-limits",
      "/api/usage/token-limits?id=limit-fixture",
    ]);
    for (const [, init] of fetch.mock.calls as Array<[string, RequestInit]>) {
      expect(init.credentials).toBe("same-origin");
      expect(new Headers(init.headers).get("x-red-router-csrf")).toBe("fixture-token");
    }
    await expect(rustTokenLimitFetch("/api/usage/other")).rejects.toThrow("token-limit");
    await expect(
      rustTokenLimitFetch("https://attacker.example/api/usage/token-limits")
    ).rejects.toThrow("same-origin");
  });

  it("rejects malformed Rust client-key access schedules", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        client_keys: [
          {
            ...clientKey,
            access_schedule: { ...clientKey.access_schedule!, from: "25:00" },
          },
        ],
      })
    );
    vi.stubGlobal("fetch", fetch);

    await expect(listRustClientKeys()).rejects.toThrow("Invalid client-key response");
  });

  it("preserves an imported schedule with no permitted days", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          client_keys: [
            { ...clientKey, access_schedule: { ...clientKey.access_schedule!, days: [] } },
          ],
        })
      )
    );
    const [key] = await listRustClientKeys();
    expect(key.access_schedule?.days).toEqual([]);
    expect(key.access_schedule?.enabled).toBe(clientKey.access_schedule!.enabled);
  });

  it("uses the Rust provider authority without accepting returned credentials", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          providers: [provider, githubCopilotProvider, xaiOAuthProvider, openferenceProvider],
        })
      )
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

    await expect(listRustProviders()).resolves.toEqual([
      provider,
      githubCopilotProvider,
      xaiOAuthProvider,
      openferenceProvider,
    ]);
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
    await expect(listRustProviders()).rejects.toThrow("Invalid provider response");

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

  it("manages Rust combos without using the legacy combo persistence routes", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ combos: [combo, fusionCombo, pipelineCombo, nestedCombo] })
      )
      .mockResolvedValueOnce(Response.json({ combo }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await expect(listRustCombos()).resolves.toEqual([
      combo,
      fusionCombo,
      pipelineCombo,
      nestedCombo,
    ]);
    await expect(
      replaceRustCombo(combo.id, {
        protocol: combo.protocol,
        strategy: combo.strategy,
        fallback: combo.fallback,
        targets: combo.targets,
        auto: combo.auto,
        enabled: combo.enabled,
      })
    ).resolves.toEqual(combo);
    await expect(clearRustComboRoutePin(combo.id)).resolves.toBeUndefined();
    await expect(disableRustCombo(combo.id)).resolves.toBeUndefined();

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/admin/combos",
      "/api/admin/combos/agent-route",
      "/api/admin/combos/agent-route/lkgp",
      "/api/admin/combos/agent-route",
    ]);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "PUT" });
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({ method: "DELETE" });
    expect(fetch.mock.calls[3]?.[1]).toMatchObject({ method: "DELETE" });
    expect(fetch.mock.calls.map(([path]) => String(path))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\/api\/combos(?:\/|$)/)])
    );
  });

  it("rejects malformed Rust fusion and pipeline contracts", async () => {
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          combos: [
            {
              ...fusionCombo,
              fusion: { ...fusionCombo.fusion, stragglerGraceMs: 90_000 },
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          combos: [
            {
              ...pipelineCombo,
              pipeline: { maxRetries: 11, retryDelayMs: 500 },
            },
          ],
        })
      );
    vi.stubGlobal("fetch", fetch);

    await expect(listRustCombos()).rejects.toThrow("Invalid combo response");
    await expect(listRustCombos()).rejects.toThrow("Invalid combo response");
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
      .mockResolvedValueOnce(Response.json({ provider_quota: providerQuota }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
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
    await expect(
      configureRustProviderQuota(providerQuota.provider_id, {
        session: { remaining_percent: 72.5 },
        limit_reached: false,
        ttl_seconds: 300,
      })
    ).resolves.toEqual(providerQuota);
    await expect(clearRustProviderQuota(providerQuota.provider_id)).resolves.toBeUndefined();
    await expect(listRustProviderQuotas()).rejects.toThrow("Invalid provider quota response");

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/admin/provider-quotas",
      "/api/admin/provider-quotas/claude-team/refresh",
      "/api/admin/provider-quotas/claude-team",
      "/api/admin/provider-quotas/claude-team",
      "/api/admin/provider-quotas",
    ]);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(fetch.mock.calls[1]?.[1]?.body).toBeUndefined();
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({
        session: { remaining_percent: 72.5 },
        limit_reached: false,
        ttl_seconds: 300,
      }),
    });
    expect(fetch.mock.calls[3]?.[1]).toMatchObject({ method: "DELETE" });
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
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ provider_health: health }));
    vi.stubGlobal("fetch", fetch);

    await expect(listRustProviderHealth()).resolves.toEqual([health]);
    await expect(resetRustProviderHealth(health.provider_id)).resolves.toBeUndefined();
    await expect(
      configureRustProviderHealth(health.provider_id, {
        failure_threshold: 8,
        degradation_threshold: 4,
        reset_timeout_ms: 45_000,
      })
    ).resolves.toBeUndefined();
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/admin/provider-health",
      "/api/admin/provider-health/claude-team",
      "/api/admin/provider-health/claude-team",
    ]);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({
        failure_threshold: 8,
        degradation_threshold: 4,
        reset_timeout_ms: 45_000,
      }),
    });
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
    await expect(readRustModelCatalog()).rejects.toThrow("Invalid model catalog response");

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
    await expect(readRustUsageSummary()).rejects.toThrow("Invalid usage response");
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/admin/usage?key_id=key_fixture&limit=1");
  });
});
