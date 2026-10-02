// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import AutoComboCatalog from "@/app/(dashboard)/dashboard/combos/AutoComboCatalog";

it("viewing presets creates no routes, and only the confirmed Create combo action saves one", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const fetcher = vi.fn(async () => Response.json({ id: "saved-route" }, { status: 201 }));
  const confirm = vi.fn(() => false);
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("confirm", confirm);
  const onCreated = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<AutoComboCatalog onComboCreated={onCreated} />));
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () =>
      container.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click()
    );
    expect(fetcher).not.toHaveBeenCalled();
    const create = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Create combo")
    )!;
    expect(create).toBeDefined();
    await act(async () => create.click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await act(async () => create.click());
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("/api/combos/duplicate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "auto/best-coding", strategy: "weighted" }),
    });
    expect(onCreated).toHaveBeenCalledWith("saved-route");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
