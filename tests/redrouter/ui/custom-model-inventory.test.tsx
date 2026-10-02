// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CustomModelsSection from "@/app/(dashboard)/dashboard/providers/[id]/components/CustomModelsSection";

let root: Root;
let container: HTMLDivElement;
const onModelsChanged = vi.fn();
const fetchMock = vi.fn();
const manuals = Array.from({ length: 205 }, (_, i) => ({
  id: `manual-${String(i).padStart(3, "0")}`,
  source: "manual",
  isHidden: false,
}));
const imported = ["imported", "api-sync", "synced", "auto-sync", "auto"].map((source) => ({
  id: `discovered-${source}`,
  source,
  isHidden: false,
}));
let stored = [...manuals, ...imported];
let failPatch = false;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  stored = [...manuals, ...imported];
  failPatch = false;
  onModelsChanged.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      if (failPatch) return Response.json({ error: { message: "Failed" } }, { status: 500 });
      const body = JSON.parse(String(init.body)) as { modelIds: string[]; isActive: boolean };
      stored = stored.map((model) =>
        body.modelIds.includes(model.id) ? { ...model, isHidden: !body.isActive } : model
      );
    }
    return Response.json({ models: stored, modelCompatOverrides: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <CustomModelsSection
        providerId="karavela"
        providerAlias="karavela"
        onCopy={vi.fn()}
        onModelsChanged={onModelsChanged}
      />
    )
  );
}
function button(title: string) {
  return container.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!;
}
const modelCodes = () =>
  [...container.querySelectorAll("code")].filter((node) =>
    node.textContent?.startsWith("karavela/manual-")
  );

it("keeps discovered records in Models and paginates manual custom models in groups of 100", async () => {
  await render();
  for (const model of imported) expect(container.textContent).not.toContain(model.id);
  expect(modelCodes()).toHaveLength(100);
  expect(container.textContent).toContain("1–100 of 205 models");
  const next = () =>
    [...container.querySelectorAll("nav button")].find(
      (node) => node.textContent === "Next"
    ) as HTMLButtonElement;
  await act(async () => next().click());
  expect(modelCodes()).toHaveLength(100);
  expect(modelCodes()[0].textContent).toBe("karavela/manual-100");
  await act(async () => next().click());
  expect(modelCodes()).toHaveLength(5);
  expect(modelCodes()[0].textContent).toBe("karavela/manual-200");
  await act(async () => button("Deactivate all matching models").click());
  const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
  expect(patch?.[0]).toBe("/api/provider-models?provider=karavela");
  expect(JSON.parse(patch?.[1].body)).toEqual({
    modelIds: manuals.map((model) => model.id),
    isActive: false,
  });
  expect(
    stored.filter((model) => model.id.startsWith("discovered-")).every((model) => !model.isHidden)
  ).toBe(true);
  expect(onModelsChanged).toHaveBeenCalledOnce();
  expect(button("Deactivate all matching models").disabled).toBe(true);
  await act(async () => button("Activate all matching models").click());
  expect(
    stored.filter((model) => model.id.startsWith("manual-")).every((model) => !model.isHidden)
  ).toBe(true);
});

it("searches the entire custom inventory and changes only matching models", async () => {
  await render();
  const search = container.querySelector<HTMLInputElement>('input[type="text"]:not([id])')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      search,
      "manual-204"
    );
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(modelCodes()).toHaveLength(1);
  expect(modelCodes()[0].textContent).toBe("karavela/manual-204");
  expect(container.querySelector("nav")).toBeNull();
  await act(async () => button("Deactivate all matching models").click());
  const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
  expect(JSON.parse(patch?.[1].body)).toEqual({ modelIds: ["manual-204"], isActive: false });
  expect(stored.filter((model) => model.isHidden).map((model) => model.id)).toEqual(["manual-204"]);
});

it("preserves legacy manual entries and leaves selections unchanged when bulk saving fails", async () => {
  stored = [{ id: "legacy", source: "", isHidden: false }, ...imported];
  failPatch = true;
  await render();
  expect(container.textContent).toContain("karavela/legacy");
  await act(async () => button("Deactivate all matching models").click());
  expect(onModelsChanged).not.toHaveBeenCalled();
  expect(stored[0].isHidden).toBe(false);
  expect(button("Deactivate all matching models").disabled).toBe(false);
});

it("refreshes Custom Models when importing changes a previously manual record", async () => {
  stored = [{ id: "previously-manual", source: "manual", isHidden: false }];
  await act(async () =>
    root.render(
      <CustomModelsSection
        providerId="karavela"
        providerAlias="karavela"
        onCopy={vi.fn()}
        inventoryModels={stored}
      />
    )
  );
  expect(container.textContent).toContain("karavela/previously-manual");
  stored = [{ id: "previously-manual", source: "imported", isHidden: false }];
  await act(async () =>
    root.render(
      <CustomModelsSection
        providerId="karavela"
        providerAlias="karavela"
        onCopy={vi.fn()}
        inventoryModels={stored}
      />
    )
  );
  expect(container.textContent).not.toContain("karavela/previously-manual");
  expect(stored[0].isHidden).toBe(false);
});
