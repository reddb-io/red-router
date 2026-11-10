// @vitest-environment jsdom

import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  authorizeRustProviderOAuth: vi.fn(),
  disableRustProvider: vi.fn(),
  exchangeRustProviderOAuth: vi.fn(),
  extractRustProviderSessionZip: vi.fn(),
  importRustProviderSession: vi.fn(),
  importRustProviderSessionsBulk: vi.fn(),
  listRustProviders: vi.fn(),
  readRustCatalogProvider: vi.fn(),
  readRustModelCatalog: vi.fn(),
  refreshRustModelCatalog: vi.fn(),
  refreshRustProviderOAuth: vi.fn(),
  replaceRustProvider: vi.fn(),
  testRustProvider: vi.fn(),
}));

vi.mock("@/lib/rustControlPlane/browserClient", () => api);
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
});
