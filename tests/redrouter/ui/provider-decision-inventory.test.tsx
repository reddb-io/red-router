// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useProviderModels } from "@/app/(dashboard)/dashboard/providers/[id]/hooks/useProviderModels";

it("merges the separate decision registry into the dashboard inventory without duplicates or activation", async () => {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
    Response.json(
      url.startsWith("/api/provider-models")
        ? { models: [], modelCompatOverrides: [] }
        : {
            models: [{ id: "chat" }, { id: "typesafe/jev-1.13" }],
            decisionModels: [
              { id: "typesafe/jev-1.13", source: "system" },
              { id: "typesafe/jev-latest", source: "system" },
            ],
            authoritative: true,
          }
    )
  );
  vi.stubGlobal("fetch", fetchMock);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Harness() {
    const state = useProviderModels("openrouter", false);
    return (
      <>
        <button onClick={() => void state.fetchProviderModelMeta()}>Load</button>
        {state.syncedAvailableModels.map((model: { id: string }) => (
          <span key={model.id} data-model={model.id} />
        ))}
      </>
    );
  }
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => container.querySelector("button")!.click());
    expect(
      [...container.querySelectorAll("[data-model]")].map((node) => node.getAttribute("data-model"))
    ).toEqual(["chat", "typesafe/jev-1.13", "typesafe/jev-latest"]);
    expect(fetchMock.mock.calls.every((args) => args.length === 1 || !args[1]?.method)).toBe(true);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
