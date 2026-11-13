// @vitest-environment jsdom

import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  listProviderNodes: vi.fn().mockResolvedValue([]),
  saveProviderNode: vi.fn(),
  deleteProviderNode: vi.fn(),
  authorizeRustProviderOAuth: vi.fn(),
  clearRustProviderQuota: vi.fn(),
  configureRustProviderHealth: vi.fn(),
  configureRustProviderQuota: vi.fn(),
  disableRustProvider: vi.fn(),
  exchangeRustProviderOAuth: vi.fn(),
  extractRustProviderSessionZip: vi.fn(),
  importRustProviderSession: vi.fn(),
  importRustProviderSessionsBulk: vi.fn(),
  listRustProviderHealth: vi.fn(),
  listRustProviderQuotas: vi.fn(),
  listRustProviders: vi.fn(),
  providerRequestHeaders: vi.fn(),
  providerDiscoveryConfig: vi.fn(),
  discoverProviderModels: vi.fn(),
  readRustCatalogProvider: vi.fn(),
  readRustModelCatalog: vi.fn(),
  refreshRustModelCatalog: vi.fn(),
  refreshRustProviderOAuth: vi.fn(),
  refreshRustProviderQuota: vi.fn(),
  resetRustProviderHealth: vi.fn(),
  replaceRustProvider: vi.fn(),
  testRustProvider: vi.fn(),
}));

vi.mock("../../../rust-dashboard/api/browserClient", () => api);
vi.mock("@/shared/components", () => ({
  Button: ({
    children,
    loading: _loading,
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    children: ReactNode;
    loading?: boolean;
    variant?: string;
  }) => <button {...props}>{children}</button>,
  Card: ({
    title,
    subtitle,
    action,
    children,
  }: {
    title?: ReactNode;
    subtitle?: ReactNode;
    action?: ReactNode;
    children: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      <p>{subtitle}</p>
      {action}
      {children}
    </section>
  ),
}));

const { default: RustProvidersPageClient } =
  await import("@/app/(dashboard)/dashboard/providers/RustProvidersPageClient");

const roots: Array<{ root: ReturnType<typeof createRoot>; container: HTMLDivElement }> = [];

beforeEach(() => {
  api.listProviderNodes.mockResolvedValue([]);
  api.providerRequestHeaders.mockResolvedValue({ names: [], attached: true, revision: null });
  api.providerDiscoveryConfig.mockResolvedValue({
    models_path: null,
    effective_models_path: "/v1/models",
    revision: null,
  });
  api.listRustProviderHealth.mockResolvedValue([]);
  api.listRustProviderQuotas.mockResolvedValue([]);
});

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.clearAllMocks();
});

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => {
    root.render(<RustProvidersPageClient />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

describe("Rust provider models.dev catalog", () => {
  it("renders the Rust snapshot and lazily inspects provider models", async () => {
    api.listRustProviders.mockResolvedValue([]);
    api.readRustModelCatalog.mockResolvedValue({
      manifest: {
        providers: 1,
        providerModels: 1,
        fetchedAt: "2026-11-09T00:00:00.000Z",
      },
      providers: [{ id: "openai", name: "OpenAI" }],
      snapshot: { source: "persisted", revision: "catalog-revision" },
    });
    api.readRustCatalogProvider.mockResolvedValue({
      id: "openai",
      name: "OpenAI",
      models: [
        {
          id: "gpt-5",
          reasoning: true,
          tool_call: true,
          limit: { context: 400_000 },
        },
      ],
    });

    const container = await mount();
    expect(container.textContent).toContain("models.dev catalog");
    expect(container.textContent).toContain("catalog-revision");
    expect(container.querySelector('option[value="openai"]')?.textContent).toContain("OpenAI");

    const input = container.querySelector(
      'input[list="rust-model-catalog-providers"]'
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "openai");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const inspect = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Inspect models"
    );
    expect(inspect).toBeDefined();
    await act(async () => {
      inspect?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(api.readRustCatalogProvider).toHaveBeenCalledWith("openai");
    expect(container.textContent).toContain("OpenAI: 1 models");
    expect(container.textContent).toContain("gpt-5");
    expect(container.textContent).toContain("context");
  });

  it("shows durable Antigravity quota and refreshes it separately from OAuth", async () => {
    const now = Date.now();
    const provider = {
      id: "agy-team",
      tenant_id: "red",
      provider: "agy",
      upstream_url: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent",
      enabled: true,
      revision: "provider-revision",
      has_credential: true,
      rate_limit_scope: "connection",
      auth_scheme: "bearer",
      label: "Antigravity team",
      credential_expired: false,
      credential_type: "oauth",
      oauth_provider: "agy",
      oauth_generation: "4",
      refreshable: true,
      oauth_refresh_state: "ready",
      reauth_required: false,
    };
    const initialQuota = {
      provider_id: provider.id,
      models: [
        {
          model_id: "gemini-3-pro",
          session: { remaining_percent: 35 },
          weekly: { remaining_percent: 61 },
          limit_reached: false,
          observed_at_unix_ms: now,
          expires_at_unix_ms: now + 180_000,
          revision: "model-quota-revision-1",
        },
      ],
      session: { remaining_percent: 72.5, reset_at_unix_ms: now + 3_600_000 },
      weekly: { remaining_percent: 48 },
      limit_reached: false,
      observed_at_unix_ms: now,
      expires_at_unix_ms: now + 180_000,
      revision: "quota-revision-1",
    };
    const refreshedQuota = {
      ...initialQuota,
      weekly: { remaining_percent: 59 },
      revision: "quota-revision-2",
    };
    api.listRustProviders.mockResolvedValue([provider]);
    api.listRustProviderHealth.mockResolvedValue([
      {
        provider_id: provider.id,
        state: "closed",
        failure_count: 0,
        retry_after_ms: 0,
        open_cycle_count: 0,
        failure_threshold: 5,
        degradation_threshold: 3,
        reset_timeout_ms: 30_000,
        connection_cooldown_until_unix_ms: 0,
        connection_retry_after_ms: 0,
        connection_backoff_level: 0,
        connection_last_status: null,
        terminal_status: null,
        ambiguous_auth_strikes: 0,
        ambiguous_auth_retry_limit: 3,
        model_lockouts: [],
      },
    ]);
    api.listRustProviderQuotas.mockResolvedValue([initialQuota]);
    api.readRustModelCatalog.mockResolvedValue({
      manifest: { providers: 1, providerModels: 1, fetchedAt: "2026-11-09T00:00:00.000Z" },
      providers: [{ id: "agy", name: "Antigravity" }],
      snapshot: { source: "persisted", revision: "catalog-revision" },
    });
    api.refreshRustProviderQuota.mockResolvedValue({
      provider_id: provider.id,
      refreshed: true,
      category: "refreshed",
      quota: refreshedQuota,
    });
    api.configureRustProviderQuota.mockResolvedValue(refreshedQuota);
    api.clearRustProviderQuota.mockResolvedValue(undefined);

    const container = await mount();
    expect(container.textContent).toContain("Provider quota");
    expect(container.textContent).toContain("72.5% remaining");
    expect(container.textContent).toContain("48% remaining");
    expect(container.textContent).toContain("Model quotas");
    expect(container.textContent).toContain("gemini-3-pro");
    expect(container.textContent).toContain("35% remaining");
    expect(container.textContent).toContain("61% remaining");
    expect(container.textContent).toContain("Runtime health");
    expect(container.textContent).toContain("Healthy");
    const saveBreaker = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save breaker policy"
    );
    await act(async () => {
      saveBreaker?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.configureRustProviderHealth).toHaveBeenCalledWith(provider.id, {
      failure_threshold: 5,
      degradation_threshold: 3,
      reset_timeout_ms: 30_000,
    });
    expect(container.textContent).toContain("Current");

    const refresh = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Refresh quota"
    );
    await act(async () => {
      refresh?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.refreshRustProviderQuota).toHaveBeenCalledWith(provider.id);
    expect(api.refreshRustProviderOAuth).not.toHaveBeenCalled();
    expect(container.textContent).toContain("59% remaining");

    const saveQuota = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save manual quota"
    );
    await act(async () => {
      saveQuota?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.configureRustProviderQuota).toHaveBeenCalledWith(
      provider.id,
      expect.objectContaining({
        session: expect.objectContaining({ remaining_percent: 72.5 }),
        weekly: { remaining_percent: 59 },
        limit_reached: false,
        ttl_seconds: expect.any(Number),
      })
    );

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const clearQuota = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Clear quota"
    );
    await act(async () => {
      clearQuota?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    confirm.mockRestore();
    expect(api.clearRustProviderQuota).toHaveBeenCalledWith(provider.id);
    expect(container.textContent).toContain("No quota snapshot collected yet");
  });

  it("completes Antigravity browser OAuth through the Rust control plane", async () => {
    api.listRustProviders.mockResolvedValue([]);
    api.readRustModelCatalog.mockResolvedValue({
      manifest: {
        providers: 0,
        providerModels: 0,
        fetchedAt: "2026-11-09T00:00:00.000Z",
      },
      providers: [],
      snapshot: { source: "bundled", revision: null },
    });
    api.authorizeRustProviderOAuth.mockResolvedValue({
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=sealed",
      state: "sealed-state",
      codeVerifier: "v".repeat(43),
      codeChallenge: "c".repeat(43),
      redirectUri: "http://127.0.0.1:20128/callback",
      flowType: "authorization_code",
      callbackPath: "/callback",
      callbackHost: "localhost",
    });
    api.exchangeRustProviderOAuth.mockResolvedValue({
      id: "agy-account",
      provider: "agy",
      email: "agent@example.com",
      displayName: "Antigravity account",
    });

    const container = await mount();
    const connect = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect Antigravity"
    );
    await act(async () => {
      connect?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.authorizeRustProviderOAuth).toHaveBeenCalledWith(
      "agy",
      `http://127.0.0.1:${window.location.port || "20128"}/callback`
    );
    expect(container.textContent).toContain("Connect Antigravity");
    const callback = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(
        callback,
        "http://127.0.0.1:20128/callback?code=provider-code&state=returned-state"
      );
      callback.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const complete = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Complete connection"
    );
    await act(async () => {
      complete?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.exchangeRustProviderOAuth).toHaveBeenCalledWith("agy", {
      code: "provider-code",
      state: "returned-state",
      redirectUri: "http://127.0.0.1:20128/callback",
      codeVerifier: "v".repeat(43),
    });
    expect(api.listRustProviders).toHaveBeenCalledTimes(2);
  });

  it("imports an existing CLI session through Rust and reloads providers", async () => {
    api.listRustProviders.mockResolvedValue([]);
    api.readRustModelCatalog.mockResolvedValue({
      manifest: { providers: 0, providerModels: 0, fetchedAt: "2026-11-09T00:00:00.000Z" },
      providers: [],
      snapshot: { source: "bundled", revision: null },
    });
    api.importRustProviderSession.mockResolvedValue({
      created: true,
      connection: { id: "codex-account" },
    });

    const container = await mount();
    const open = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Import existing CLI sessions"
    );
    await act(async () => {
      open?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, '{"tokens":{"access_token":"fixture"}}');
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Import sessions"
    );
    await act(async () => {
      submit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.importRustProviderSession).toHaveBeenCalledWith(
      "codex",
      { json: { tokens: { access_token: "fixture" } } },
      false
    );
    expect(api.listRustProviders).toHaveBeenCalledTimes(2);
  });
  it("preserves a custom protocol and requires credentials before changing it", async () => {
    const provider = {
      id: "custom-path",
      tenant_id: "red",
      provider: "openai-compatible",
      protocol: "openai",
      upstream_url: "https://api.example.com/custom/infer",
      enabled: true,
      revision: "1",
      has_credential: true,
      rate_limit_scope: "auto",
      auth_scheme: "auto",
      label: "Custom account",
      credential_type: "static",
      credential_expired: false,
      refreshable: false,
      reauth_required: false,
    };
    api.listRustProviders.mockResolvedValue([provider]);
    api.readRustModelCatalog.mockResolvedValue({
      manifest: { providers: 0, providerModels: 0, fetchedAt: "2026-11-13T00:00:00Z" },
      providers: [],
      snapshot: { source: "persisted", revision: "1" },
    });
    api.replaceRustProvider.mockResolvedValue(provider);
    const container = await mount();
    const click = async (text: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (entry) => entry.textContent === text
      );
      expect(button).toBeDefined();
      await act(async () => {
        button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };
    await click("Replace");
    let select = [...container.querySelectorAll("select")].find((entry) =>
      entry.querySelector('option[value="openai-responses"]')
    )!;
    expect(select.value).toBe("openai");
    await click("Replace connection");
    expect(api.replaceRustProvider).toHaveBeenLastCalledWith(
      "custom-path",
      expect.objectContaining({ protocol: "openai", api_key: "" })
    );
    api.replaceRustProvider.mockClear();
    await click("Replace");
    select = [...container.querySelectorAll("select")].find((entry) =>
      entry.querySelector('option[value="openai-responses"]')
    )!;
    await act(async () => {
      select.value = "anthropic";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Replace connection");
    expect(api.replaceRustProvider).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Re-enter the provider credential");
    const credential = container.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        credential,
        "replacement-secret"
      );
      credential.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Replace connection");
    expect(api.replaceRustProvider).toHaveBeenCalledWith(
      "custom-path",
      expect.objectContaining({ protocol: "anthropic", api_key: "replacement-secret" })
    );
  });
  it("binds account credentials to reusable definitions and edits shared settings explicitly", async () => {
    const node = {
      id: "company-node",
      tenant_id: "red",
      name: "Company API",
      prefix: "company-api",
      protocol: "openai",
      base_url: "https://gateway.example/v1",
      chat_path: "/infer",
      upstream_url: "https://gateway.example/v1/infer",
      models_path: "/catalog",
      revision: "1",
    };
    api.listProviderNodes.mockResolvedValue([node]);
    api.listRustProviders.mockResolvedValue([
      {
        id: "node-account",
        node_id: node.id,
        protocol: node.protocol,
        tenant_id: "red",
        provider: node.prefix,
        upstream_url: node.upstream_url,
        enabled: true,
        revision: "1",
        has_credential: true,
        rate_limit_scope: "auto",
        auth_scheme: "auto",
        label: "Node account",
        credential_type: "static",
        credential_expired: false,
        refreshable: false,
        reauth_required: false,
      },
    ]);
    api.readRustModelCatalog.mockResolvedValue({
      manifest: { providers: 0, providerModels: 0, fetchedAt: "2026-11-13T00:00:00Z" },
      providers: [],
      snapshot: { source: "persisted", revision: "1" },
    });
    api.saveProviderNode.mockResolvedValue(node);
    const container = await mount();
    const click = async (text: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (entry) => entry.textContent === text
      )!;
      expect(button).toBeDefined();
      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };
    await click("Replace");
    const selector = [...container.querySelectorAll("select")].find((entry) =>
      entry.querySelector('option[value="company-node"]')
    )!;
    expect(selector.value).toBe("company-node");
    const upstream = [...container.querySelectorAll("input")].find(
      (entry) => entry.value === node.upstream_url
    )!;
    expect(upstream.disabled).toBe(true);
    await click("Replace connection");
    expect(api.replaceRustProvider).toHaveBeenLastCalledWith(
      "node-account",
      expect.objectContaining({ node_id: "company-node", api_key: "" })
    );
    expect(
      [...container.querySelectorAll("button")].find(
        (entry) => entry.textContent === "Remove definition"
      )?.disabled
    ).toBe(true);
    await click("Edit definition");
    expect(container.textContent).toContain("1 linked accounts");
    const form = container.querySelector("form")!;
    const consent = form.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(consent.checked).toBe(false);
    await act(async () => {
      consent.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(api.saveProviderNode).toHaveBeenCalledWith(
      "company-node",
      expect.objectContaining({
        base_url: node.base_url,
        protocol: "openai",
        apply_to_connections: true,
        models_path: "/catalog",
      })
    );
  });
});
