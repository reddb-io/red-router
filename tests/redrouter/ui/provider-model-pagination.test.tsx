// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/app/(dashboard)/dashboard/providers/[id]/components/useStrictFreeBadge", () => ({
  useStrictFreeBadge: () => false,
}));
vi.mock("@/app/(dashboard)/dashboard/providers/[id]/components/PassthroughModelRow", () => ({
  default: ({ modelId }: { modelId: string }) => <div data-model-id={modelId}>{modelId}</div>,
}));

import PaginatedProviderModels from "@/app/(dashboard)/dashboard/providers/[id]/components/PaginatedProviderModels";
import CompatibleModelsSection, {
  type CompatibleModelsSectionProps,
} from "@/app/(dashboard)/dashboard/providers/[id]/components/CompatibleModelsSection";

const models = Array.from({ length: 205 }, (_, i) => ({
  id: `model-${String(i).padStart(3, "0")}`,
}));
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("fetch", async () => Response.json({ modelContextOverrides: [] }));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const rows = () => [...container.querySelectorAll("[data-model-id]")];
const navigate = (label: string, bottom = false) => {
  const nav = container.querySelector(
    `nav[aria-label="Model pagination (${bottom ? "bottom" : "top"})"]`
  )!;
  return [...nav.querySelectorAll("button")].find((node) => node.textContent === label)!;
};
function list(items = models, resetKey = "all") {
  return (
    <PaginatedProviderModels models={items} resetKey={resetKey}>
      {(page) =>
        page.map((model) => (
          <div key={model.id} data-model-id={model.id}>
            {model.id}
          </div>
        ))
      }
    </PaginatedProviderModels>
  );
}

it("renders 100, 100 and 5 rows, with synchronized controls at both ends", async () => {
  await act(async () => root.render(list()));
  expect(rows()).toHaveLength(100);
  expect(rows()[0].textContent).toBe("model-000");
  expect(rows().at(-1)?.textContent).toBe("model-099");
  expect(navigate("Previous").disabled).toBe(true);
  await act(async () => navigate("Next", true).click());
  expect(rows()).toHaveLength(100);
  expect(rows()[0].textContent).toBe("model-100");
  expect(container.textContent).toContain("101–200 of 205 models");
  await act(async () => navigate("Next").click());
  expect(rows()).toHaveLength(5);
  expect(rows()[0].textContent).toBe("model-200");
  expect(navigate("Next").disabled).toBe(true);
  expect(navigate("Next", true).disabled).toBe(true);
  await act(async () => navigate("Previous").click());
  expect(rows()[0].textContent).toBe("model-100");
});

it("resets for changed filters and clamps after deletions without reviving an invalid page", async () => {
  await act(async () => root.render(list()));
  await act(async () => navigate("Next").click());
  await act(async () => navigate("Next").click());
  await act(async () => root.render(list(models.slice(0, 101))));
  expect(rows()).toHaveLength(1);
  expect(rows()[0].textContent).toBe("model-100");
  await act(async () => root.render(list()));
  expect(rows()[0].textContent).toBe("model-100");
  await act(async () => root.render(list(models, "different-filter")));
  expect(rows()[0].textContent).toBe("model-000");
  await act(async () => root.render(list([])));
  expect(rows()).toHaveLength(0);
  expect(container.querySelector("nav")).toBeNull();
});

it("searches all compatible-provider models and bulk actions retain the full filtered scope", async () => {
  const onBulkToggleHidden = vi.fn().mockResolvedValue(undefined);
  const onTestAll = vi.fn().mockResolvedValue(undefined);
  const props: CompatibleModelsSectionProps = {
    providerStorageAlias: "openrouter",
    providerDisplayAlias: "openrouter",
    modelAliases: {},
    availableModels: models,
    allowImport: false,
    description: "",
    inputLabel: "Add a model",
    inputPlaceholder: "Model ID",
    onCopy: vi.fn(),
    onSetAlias: vi.fn().mockResolvedValue(undefined),
    onDeleteAlias: vi.fn(),
    connections: [],
    onImportWithProgress: vi.fn().mockResolvedValue(undefined),
    t: (key) => key,
    effectiveModelNormalize: () => false,
    effectiveModelPreserveDeveloper: () => false,
    getUpstreamHeadersRecord: () => ({}),
    saveModelCompatFlags: vi.fn().mockResolvedValue(undefined),
    isModelHidden: () => false,
    onToggleHidden: vi.fn().mockResolvedValue(undefined),
    onBulkToggleHidden,
    onTestAll,
  };
  await act(async () => root.render(<CompatibleModelsSection {...props} />));
  await act(async () => navigate("Next").click());
  expect(rows()).toHaveLength(100);
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('button[title="Deactivate all matching models"]')!
      .click()
  );
  expect(onBulkToggleHidden).toHaveBeenLastCalledWith(
    models.map((model) => model.id),
    true
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[title="Test all"]')!.click()
  );
  expect(onTestAll).toHaveBeenLastCalledWith(
    models.map((model) => ({
      modelId: model.id,
      fullModel: `openrouter/${model.id}`,
    }))
  );

  // The search result is on page three of the unfiltered inventory.
  const search = container.querySelector<HTMLInputElement>('input[placeholder="Filter models…"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      search,
      "model-204"
    );
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(rows()).toHaveLength(1);
  expect(rows()[0].textContent).toBe("model-204");
  expect(container.querySelector("nav")).toBeNull();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('button[title="Deactivate all matching models"]')!
      .click()
  );
  expect(onBulkToggleHidden).toHaveBeenLastCalledWith(["model-204"], true);
});
