// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteRustClientKey,
  disableRustProvider,
  issueRustClientKey,
  listRustClientKeys,
  listRustProviders,
  readRustCatalogProvider,
  readRustModelCatalog,
  readRustUsageSummary,
  readRustAdminCsrfCookie,
  readRustAuthConfig,
  replaceRustClientKey,
  replaceRustProvider,
  refreshRustModelCatalog,
  rustAdminFetch,
  testRustProvider,
  type RustClientKey,
  type RustProvider,
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
