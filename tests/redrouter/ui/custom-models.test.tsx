// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({
  listProviderModels: vi.fn(),
  saveProviderModel: vi.fn(),
  deleteProviderModel: vi.fn(),
  readProviderModel: vi.fn(),
}));
vi.mock("../../../rust-dashboard/api/providerModels", () => api);
import CustomModels from "../../../rust-dashboard/CustomModels";
const model = {
  id: "model-1",
  tenant_id: "red",
  provider: "private-api",
  revision: "1",
  metadata: {
    id: "private-model",
    name: "Private model",
    family: "preserved-family",
    cost: { input: 1, output: 2 },
    reasoning_options: [{ type: "toggle" }],
  },
  effective: {
    id: "private-model",
    name: "Private model",
    cost: { input: 1, output: 2 },
    limit: { context: 4096 },
  },
};
const page = (models: unknown[]) => ({ models, total: models.length, offset: 0, limit: 50 });
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  api.listProviderModels.mockResolvedValue(page([]));
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<CustomModels />);
    await Promise.resolve();
  });
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === text
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
function input(label: string) {
  return [...container.querySelectorAll("label")]
    .find((entry) => entry.textContent?.startsWith(label))!
    .querySelector("input,select") as HTMLInputElement | HTMLSelectElement;
}
async function type(label: string, value: string) {
  const element = input(label);
  await act(async () => {
    if (element instanceof HTMLSelectElement) {
      element.value = value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        element,
        value
      );
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
}
it("saves explicit zero prices and false capabilities while leaving unspecified prices inherited", async () => {
  api.saveProviderModel.mockResolvedValue(model);
  api.listProviderModels.mockResolvedValueOnce(page([])).mockResolvedValue(page([model]));
  await mount();
  await click("Add custom model");
  await type("Model provider", "private-api");
  await type("Custom model ID", "private-model");
  await type("Model display name", "Private model");
  await type("Context window", "4096");
  await type("Input price", "0");
  await type("Output price", "1.5");
  await type("Tools support", "false");
  await click("Save custom model");
  expect(api.saveProviderModel).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "private-api",
      metadata: expect.objectContaining({
        id: "private-model",
        cost: { input: 0, output: 1.5 },
        limit: { context: 4096 },
        tool_call: false,
      }),
    }),
    undefined
  );
  expect(container.textContent).toContain("Custom model saved.");
  expect(container.textContent).toContain("Private model");
});
it("keeps conflicting edits visible and reloads the current revision without dropping unedited metadata", async () => {
  api.listProviderModels.mockResolvedValue(page([model]));
  api.saveProviderModel
    .mockRejectedValueOnce(new Error("Provider model changed; reload and retry"))
    .mockResolvedValue(model);
  const latest = {
    ...model,
    revision: "2",
    metadata: { ...model.metadata, name: "Changed elsewhere", cost: { input: 3, output: 2 } },
  };
  api.readProviderModel.mockResolvedValue(latest);
  await mount();
  await click("Edit model");
  await type("Model display name", "My pending edit");
  await click("Save custom model");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("changed; reload");
  expect(input("Model display name").value).toBe("My pending edit");
  await click("Discard edits and reload");
  expect(input("Model display name").value).toBe("Changed elsewhere");
  expect(input("Input price").value).toBe("3");
  await click("Save custom model");
  expect(api.saveProviderModel).toHaveBeenLastCalledWith(
    expect.objectContaining({
      revision: "2",
      metadata: expect.objectContaining({
        family: "preserved-family",
        reasoning_options: [{ type: "toggle" }],
        cost: { input: 3, output: 2 },
      }),
    }),
    "model-1"
  );
});

it("preserves and edits client catalog visibility", async () => {
  const hidden = { ...model, hidden: true };
  api.listProviderModels.mockResolvedValue(page([hidden]));
  api.saveProviderModel.mockResolvedValue({ ...hidden, hidden: false, revision: "2" });
  await mount();
  expect(container.textContent).toContain("Hidden");
  await click("Edit model");
  const visibility = input("Hide from client model lists") as HTMLInputElement;
  expect(visibility.checked).toBe(true);
  await act(async () => {
    visibility.click();
  });
  await click("Save custom model");
  expect(api.saveProviderModel).toHaveBeenCalledWith(
    expect.objectContaining({ hidden: false, revision: "1" }),
    "model-1"
  );
});
