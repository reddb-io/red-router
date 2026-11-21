// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import ProviderDiscovery from "../../../rust-dashboard/ProviderDiscovery";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({
  providerDiscoveryConfig: vi.fn(),
  discoverProviderModels: vi.fn(),
  adoptLegacyProviderModels: vi.fn(),
}));
vi.mock("../../../rust-dashboard/api/browserClient", () => api);
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.resetAllMocks();
});
async function render(id = "account-a") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const select = vi.fn();
  await act(async () => {
    root.render(<ProviderDiscovery id={id} onSelect={select} />);
  });
  return { container, root, select };
}
async function click(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (value) => value.textContent === label
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
  });
}
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("restores migrated models for the selected account and explains their unknown age", async () => {
  api.providerDiscoveryConfig.mockResolvedValue({
    models_path: null,
    effective_models_path: "/v1/models",
    revision: null,
    legacy_inventory_available: true,
  });
  api.adoptLegacyProviderModels.mockResolvedValue(3);
  const { container } = await render();
  expect(container.textContent).toContain("Migrated models may be out of date");
  await click(container, "Restore migrated models");
  expect(api.adoptLegacyProviderModels).toHaveBeenCalledWith("account-a");
  expect(container.textContent).toContain("Restored 3 models. Their age is unknown");
  expect(container.textContent).toContain("Restored models have not been verified");
  expect(container.textContent).not.toContain("Restore migrated models");
});
it("discovers a Copilot account using its fixed path without offering path overrides", async () => {
  api.providerDiscoveryConfig.mockResolvedValue({
    models_path: null,
    effective_models_path: "/models",
    revision: null,
    legacy_inventory_available: true,
  });
  api.discoverProviderModels.mockResolvedValue([{ id: "gpt-5.4" }]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<ProviderDiscovery id="copilot" onSelect={vi.fn()} fixedPath />);
  });
  expect(container.textContent).not.toContain("Models path override");
  expect(container.textContent).not.toContain("Restore migrated models");
  await click(container, "Discover models");
  expect(api.discoverProviderModels).toHaveBeenCalledWith("copilot");
  expect(container.textContent).toContain("gpt-5.4");
});
it("saves the override, resets to default and uses persisted settings for discovery", async () => {
  api.providerDiscoveryConfig
    .mockResolvedValueOnce({
      models_path: null,
      effective_models_path: "/v1/models",
      revision: null,
    })
    .mockResolvedValueOnce({
      models_path: "/custom/models",
      effective_models_path: "/custom/models",
      revision: "1",
    })
    .mockResolvedValueOnce({
      models_path: null,
      effective_models_path: "/v1/models",
      revision: null,
    });
  const { container } = await render();
  await input(container.querySelector("input")!, "/custom/models");
  await click(container, "Save models path");
  expect(api.providerDiscoveryConfig).toHaveBeenLastCalledWith("account-a", "/custom/models");
  expect(container.textContent).toContain("Saved path: /custom/models");
  await click(container, "Use default path");
  expect(api.providerDiscoveryConfig).toHaveBeenLastCalledWith("account-a", null);
  expect(container.querySelector("input")?.value).toBe("");
});
it("bounds the model list, filters it and selects the exact account model for a test", async () => {
  api.providerDiscoveryConfig.mockResolvedValue({
    models_path: null,
    effective_models_path: "/v1/models",
    revision: null,
  });
  api.discoverProviderModels.mockResolvedValue(
    Array.from({ length: 56 }, (_, index) => ({
      id: `model-${String(index).padStart(2, "0")}`,
      context_length: 32768,
    }))
  );
  const { container, select } = await render();
  await click(container, "Discover models");
  expect(api.discoverProviderModels).toHaveBeenCalledWith("account-a");
  expect(container.querySelectorAll("li")).toHaveLength(50);
  expect(container.textContent).toContain("56 of 56 models");
  await click(container, "Next models");
  expect(container.querySelectorAll("li")).toHaveLength(6);
  await input(container.querySelectorAll("input")[1], "model-55");
  expect(container.querySelectorAll("li")).toHaveLength(1);
  await click(container, "Use for test");
  expect(select).toHaveBeenCalledWith("model-55");
});
it("clears stale results after a failed refresh and retains the saved configuration", async () => {
  api.providerDiscoveryConfig.mockResolvedValue({
    models_path: "/custom/models",
    effective_models_path: "/custom/models",
    revision: "1",
  });
  api.discoverProviderModels
    .mockResolvedValueOnce([{ id: "old-model" }])
    .mockRejectedValueOnce(new Error("Provider unavailable"));
  const { container } = await render();
  await click(container, "Discover models");
  expect(container.textContent).toContain("old-model");
  await click(container, "Discover models");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Provider unavailable");
  expect(container.textContent).not.toContain("old-model");
  expect(container.querySelector("input")?.value).toBe("/custom/models");
});
it("does not show another account's late discovery settings after switching accounts", async () => {
  let resolveFirst!: (value: unknown) => void;
  api.providerDiscoveryConfig
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    )
    .mockResolvedValueOnce({
      models_path: "/second/models",
      effective_models_path: "/second/models",
      revision: "2",
    });
  const { container, root, select } = await render();
  await act(async () => {
    root.render(<ProviderDiscovery id="account-b" onSelect={select} />);
  });
  await act(async () => {
    resolveFirst({
      models_path: "/first/models",
      effective_models_path: "/first/models",
      revision: "1",
    });
  });
  expect(container.querySelector("input")?.value).toBe("/second/models");
  expect(container.textContent).not.toContain("/first/models");
});
