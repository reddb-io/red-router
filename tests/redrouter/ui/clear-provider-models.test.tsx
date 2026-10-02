// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useProviderModels } from "@/app/(dashboard)/dashboard/providers/[id]/hooks/useProviderModels";
import { useModelVisibilityHandlers } from "@/app/(dashboard)/dashboard/providers/[id]/hooks/useModelVisibilityHandlers";

it("Clear all models empties the RedRouter listing using the stored provider ID and refreshes its aliases", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let cleared = false;
  const aliases: Record<string, string> = {
    local: "red/vendor/model",
    other: "openai/gpt-6-astra",
  };
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    if (init?.method === "DELETE") {
      if (url.pathname === "/api/provider-models") {
        cleared = url.searchParams.get("provider") === "red-router";
        return Response.json({ cleared });
      }
      delete aliases[url.searchParams.get("alias")!];
      return Response.json({ removed: true });
    }
    if (url.pathname === "/api/models/alias") return Response.json({ aliases: { ...aliases } });
    if (url.pathname === "/api/provider-models")
      return Response.json({ models: cleared ? [] : [{ id: "custom-model" }] });
    return Response.json({ models: cleared ? [] : [{ id: "vendor/model" }], authoritative: true });
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true)
  );
  const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
  function Harness() {
    const state = useProviderModels("red-router", false);
    const handlers = useModelVisibilityHandlers({
      providerId: "red-router",
      providerStorageAlias: "red",
      modelAliases: state.modelAliases,
      customMap: new Map(),
      fetchProviderModelMeta: state.fetchProviderModelMeta,
      fetchAliases: state.fetchAliases,
      notify: notify as unknown as Parameters<typeof useModelVisibilityHandlers>[0]["notify"],
      t: (key) => key,
      selectedConnection: { id: "remote", provider: "red-router" },
      providerNode: null,
    });
    return (
      <>
        <button onClick={() => Promise.all([state.fetchProviderModelMeta(), state.fetchAliases()])}>
          Load
        </button>
        <button disabled={handlers.clearingModels} onClick={handlers.handleClearAllModels}>
          Clear
        </button>
        {[...state.modelMeta.customModels, ...state.syncedAvailableModels].map((model) => (
          <span data-model={model.id} key={model.id}>
            {model.id}
          </span>
        ))}
      </>
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => container.querySelectorAll<HTMLButtonElement>("button")[0].click());
    expect(container.querySelectorAll("[data-model]")).toHaveLength(2);
    await act(async () => container.querySelectorAll<HTMLButtonElement>("button")[1].click());
    expect(container.querySelectorAll("[data-model]")).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledWith("/api/provider-models?provider=red-router&all=true", {
      method: "DELETE",
    });
    expect(aliases).toEqual({ other: "openai/gpt-6-astra" });
    expect(notify.success).toHaveBeenCalledWith("clearAllModelsSuccess");
    expect(notify.error).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
