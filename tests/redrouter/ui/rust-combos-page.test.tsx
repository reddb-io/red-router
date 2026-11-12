// @vitest-environment jsdom

import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  clearRustComboRoutePin: vi.fn(),
  disableRustCombo: vi.fn(),
  listRustCombos: vi.fn(),
  listRustProviderHealth: vi.fn(),
  listRustProviderQuotas: vi.fn(),
  listRustProviders: vi.fn(),
  readRustCatalogProvider: vi.fn(),
  replaceRustCombo: vi.fn(),
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

const { default: RustCombosPageClient } =
  await import("@/app/(dashboard)/dashboard/combos/RustCombosPageClient");

const provider = {
  id: "openrouter-main",
  tenant_id: "red",
  provider: "openrouter",
  upstream_url: "https://openrouter.ai/api/v1/chat/completions",
  enabled: true,
  revision: "provider-revision",
  has_credential: true,
  rate_limit_scope: "model",
  auth_scheme: "bearer",
  label: "OpenRouter production",
  credential_expired: false,
  credential_type: "static",
  refreshable: false,
  reauth_required: false,
};

const combo = {
  id: "coding",
  tenant_id: "red",
  protocol: "openai",
  strategy: "lkgp",
  fallback: true,
  targets: [{ provider_id: provider.id, model: "openai/gpt-5.3-codex" }],
  enabled: true,
  revision: "combo-revision",
  last_known_good: {
    provider_id: provider.id,
    model: "openai/gpt-5.3-codex",
    revision: "pin-revision",
  },
};

const roots: Array<{ root: ReturnType<typeof createRoot>; container: HTMLDivElement }> = [];

beforeEach(() => {
  api.listRustCombos.mockResolvedValue([combo]);
  api.listRustProviders.mockResolvedValue([provider]);
  api.listRustProviderQuotas.mockResolvedValue([
    {
      provider_id: provider.id,
      session: { remaining_percent: 74 },
      limit_reached: false,
      observed_at_unix_ms: 1_800_000_000_000,
      expires_at_unix_ms: 1_800_000_300_000,
      revision: "quota-revision",
    },
  ]);
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
  api.readRustCatalogProvider.mockResolvedValue({
    id: "openrouter",
    name: "OpenRouter",
    models: [{ id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex" }],
  });
  api.replaceRustCombo.mockResolvedValue(combo);
  api.clearRustComboRoutePin.mockResolvedValue(undefined);
  api.disableRustCombo.mockResolvedValue(undefined);
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
    root.render(<RustCombosPageClient />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelect(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Rust combo manager", () => {
  it("creates routes through Rust and surfaces models.dev, quota, health and LKGP", async () => {
    const container = await mount();
    expect(container.textContent).toContain("Rust-owned routes");
    expect(container.textContent).toContain("coding");
    expect(container.textContent).toContain("74% quota");
    expect(container.textContent).toContain("healthy");
    expect(container.textContent).toContain("Last known good");
    expect(container.textContent).toContain("Context relay");

    const id = container.querySelector('input[placeholder="fast-coding"]') as HTMLInputElement;
    const providerSelect = [...container.querySelectorAll("select")].find((select) =>
      [...select.options].some((option) => option.value === provider.id)
    ) as HTMLSelectElement;
    await act(async () => {
      setInput(id, "new-coding");
      setSelect(providerSelect, provider.id);
      await Promise.resolve();
    });
    const model = container.querySelector('input[placeholder="gpt-5.3-codex"]') as HTMLInputElement;
    await act(async () => {
      model.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      setInput(model, "openai/gpt-5.3-codex");
    });
    expect(api.readRustCatalogProvider).toHaveBeenCalledWith("openrouter");

    const create = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Create combo"
    );
    await act(async () => {
      create?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.replaceRustCombo).toHaveBeenCalledWith("new-coding", {
      protocol: "openai",
      strategy: "priority",
      fallback: true,
      targets: [{ provider_id: provider.id, model: "openai/gpt-5.3-codex" }],
      enabled: true,
    });

    const clear = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Clear last-known-good"
    );
    await act(async () => {
      clear?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(api.clearRustComboRoutePin).toHaveBeenCalledWith(combo.id);

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const disable = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Disable"
    );
    await act(async () => {
      disable?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    confirm.mockRestore();
    expect(api.disableRustCombo).toHaveBeenCalledWith(combo.id);
  });

  it("edits and persists Rust automatic routing weights", async () => {
    const autoCombo = {
      ...combo,
      strategy: "auto",
      auto: { weights: { quota: 0.3, cost: 0.25, context: 0.15, load: 0.3 } },
      last_known_good: undefined,
    };
    api.listRustCombos.mockResolvedValue([autoCombo]);
    api.replaceRustCombo.mockResolvedValue(autoCombo);
    const container = await mount();
    const edit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Edit"
    );
    await act(async () => {
      edit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Automatic routing weights");
    const weights = container.querySelectorAll('input[type="number"][max="1"]');
    expect(weights).toHaveLength(4);
    await act(async () => setInput(weights[0] as HTMLInputElement, "0.6"));
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save combo"
    );
    await act(async () => {
      save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.replaceRustCombo).toHaveBeenCalledWith(combo.id, {
      protocol: combo.protocol,
      strategy: "auto",
      fallback: combo.fallback,
      targets: combo.targets,
      auto: { weights: { quota: 0.6, cost: 0.25, context: 0.15, load: 0.3 } },
      enabled: combo.enabled,
    });
  });

  it("edits and persists Rust context relay settings", async () => {
    const relayCombo = {
      ...combo,
      strategy: "context-relay",
      context_relay: {
        handoffThreshold: 0.85,
        handoffModel: "openai/gpt-5-mini",
        handoffProviders: ["codex"],
        maxMessagesForSummary: 30,
        relayMode: "standard",
      },
      last_known_good: undefined,
    };
    api.listRustCombos.mockResolvedValue([relayCombo]);
    api.replaceRustCombo.mockResolvedValue(relayCombo);
    const container = await mount();
    const edit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Edit"
    );
    await act(async () => {
      edit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Context relay handoff");
    const threshold = container.querySelector('input[max="0.94"]') as HTMLInputElement;
    const messages = container.querySelector('input[max="100"]') as HTMLInputElement;
    const summaryModel = container.querySelector('input[maxlength="200"]') as HTMLInputElement;
    const providers = container.querySelector('input[placeholder="codex"]') as HTMLInputElement;
    const mode = [...container.querySelectorAll("select")].find((select) =>
      [...select.options].some((option) => option.value === "schema-locked")
    ) as HTMLSelectElement;
    await act(async () => {
      setInput(threshold, "0.8");
      setInput(messages, "24");
      setInput(summaryModel, "openai/gpt-5.3-codex");
      setInput(providers, "Codex, OpenAI, codex");
      setSelect(mode, "schema-locked");
    });
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save combo"
    );
    await act(async () => {
      save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.replaceRustCombo).toHaveBeenCalledWith(combo.id, {
      protocol: combo.protocol,
      strategy: "context-relay",
      fallback: combo.fallback,
      targets: combo.targets,
      context_relay: {
        handoffThreshold: 0.8,
        handoffModel: "openai/gpt-5.3-codex",
        handoffProviders: ["codex", "openai"],
        maxMessagesForSummary: 24,
        relayMode: "schema-locked",
      },
      enabled: combo.enabled,
    });
  });

  it("edits and persists Rust sequential pipeline settings and stage prompts", async () => {
    const pipelineCombo = {
      ...combo,
      strategy: "pipeline",
      targets: [
        {
          ...combo.targets[0],
          prompt: "Review the implementation.",
        },
      ],
      pipeline: { maxRetries: 1, retryDelayMs: 500 },
      last_known_good: undefined,
    };
    api.listRustCombos.mockResolvedValue([pipelineCombo]);
    api.replaceRustCombo.mockResolvedValue(pipelineCombo);
    const container = await mount();
    const edit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Edit"
    );
    await act(async () => {
      edit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Sequential pipeline");
    const retries = container.querySelector('input[max="10"]') as HTMLInputElement;
    const delay = container.querySelector('input[max="60000"]') as HTMLInputElement;
    const prompt = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      setInput(retries, "2");
      setInput(delay, "750");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(prompt, "  Produce the final client answer.  ");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save combo"
    );
    await act(async () => {
      save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.replaceRustCombo).toHaveBeenCalledWith(combo.id, {
      protocol: combo.protocol,
      strategy: "pipeline",
      fallback: combo.fallback,
      targets: [
        {
          ...combo.targets[0],
          prompt: "Produce the final client answer.",
        },
      ],
      pipeline: { maxRetries: 2, retryDelayMs: 750 },
      enabled: combo.enabled,
    });
  });

  it("edits and persists a Rust fusion panel with a configured judge", async () => {
    const fusionCombo = {
      ...combo,
      strategy: "fusion",
      fusion: {
        judgeModel: `${provider.id}/${combo.targets[0].model}`,
        minPanel: 1,
        stragglerGraceMs: 8_000,
        panelTimeoutMs: 90_000,
      },
      last_known_good: undefined,
    };
    api.listRustCombos.mockResolvedValue([fusionCombo]);
    api.replaceRustCombo.mockResolvedValue(fusionCombo);
    const container = await mount();
    const edit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Edit"
    );
    await act(async () => {
      edit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Fusion panel");
    const judge = container.querySelector(
      'input[placeholder="provider-id/model-id"]'
    ) as HTMLInputElement;
    const minPanel = container.querySelector('input[max="8"]') as HTMLInputElement;
    await act(async () => {
      setInput(judge, combo.targets[0].model);
      setInput(minPanel, "1");
    });
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save combo"
    );
    await act(async () => {
      save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.replaceRustCombo).toHaveBeenCalledWith(combo.id, {
      protocol: combo.protocol,
      strategy: "fusion",
      fallback: combo.fallback,
      targets: combo.targets,
      fusion: {
        judgeModel: combo.targets[0].model,
        minPanel: 1,
        stragglerGraceMs: 8_000,
        panelTimeoutMs: 90_000,
      },
      enabled: combo.enabled,
    });
  });

  it("edits and persists a nested combo reference for Rust flattening", async () => {
    const nestedCombo = {
      ...combo,
      id: "nested-coding",
      strategy: "priority",
      targets: [{ kind: "combo-ref", combo_id: combo.id }],
      last_known_good: undefined,
    };
    api.listRustCombos.mockResolvedValue([combo, nestedCombo]);
    api.replaceRustCombo.mockResolvedValue(nestedCombo);
    const container = await mount();
    expect(container.textContent).toContain("Expanded safely by the Rust proxy");
    const editButtons = [...container.querySelectorAll("button")].filter(
      (button) => button.textContent === "Edit"
    );
    await act(async () => {
      editButtons[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Nested combo (flatten)");
    const reference = [...container.querySelectorAll("select")].find((select) =>
      [...select.options].some((option) => option.value === combo.id)
    ) as HTMLSelectElement;
    expect(reference.value).toBe(combo.id);
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save combo"
    );
    await act(async () => {
      save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.replaceRustCombo).toHaveBeenCalledWith(nestedCombo.id, {
      protocol: combo.protocol,
      strategy: "priority",
      fallback: combo.fallback,
      targets: [{ kind: "combo-ref", combo_id: combo.id }],
      enabled: combo.enabled,
    });
  });
});
