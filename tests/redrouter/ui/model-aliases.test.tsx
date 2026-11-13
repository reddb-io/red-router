// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({
  listModelAliases: vi.fn(),
  readModelAlias: vi.fn(),
  saveModelAlias: vi.fn(),
  deleteModelAlias: vi.fn(),
}));
vi.mock("../../../rust-dashboard/api/modelAliases", () => api);
import ModelAliases from "../../../rust-dashboard/ModelAliases";
const model = {
  id: "alias-1",
  tenant_id: "red",
  alias: "friendly",
  provider: "private-api",
  model: "upstream",
  protocol: "openai",
  enabled: true,
  revision: "1",
};
const page = (aliases: unknown[]) => ({ aliases, total: aliases.length, offset: 0, limit: 50 });
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  api.listModelAliases.mockResolvedValue(page([]));
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
    root!.render(<ModelAliases />);
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
it("publishes a named model with organization, target and protocol", async () => {
  api.saveModelAlias.mockResolvedValue(model);
  api.listModelAliases.mockResolvedValueOnce(page([])).mockResolvedValue(page([model]));
  await mount();
  await click("Add model alias");
  await type("Alias organization ID", "red");
  await type("Client model name", "friendly");
  await type("Alias provider", "private-api");
  await type("Upstream model ID", "upstream");
  await type("Alias protocol", "openai-responses");
  await click("Save model alias");
  expect(api.saveModelAlias).toHaveBeenCalledWith(
    {
      tenant_id: "red",
      alias: "friendly",
      provider: "private-api",
      model: "upstream",
      protocol: "openai-responses",
      enabled: true,
    },
    undefined
  );
  expect(container.textContent).toContain("Model alias saved.");
});
it("keeps a conflicting target edit and reloads the current alias revision", async () => {
  api.listModelAliases.mockResolvedValue(page([model]));
  api.saveModelAlias
    .mockRejectedValueOnce(new Error("Model alias changed; reload and retry"))
    .mockResolvedValue(model);
  api.readModelAlias.mockResolvedValue({ ...model, model: "changed-upstream", revision: "2" });
  await mount();
  await click("Edit alias");
  await type("Upstream model ID", "my-edit");
  await click("Save model alias");
  expect(input("Upstream model ID").value).toBe("my-edit");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("changed; reload");
  await click("Discard alias edits and reload");
  expect(input("Upstream model ID").value).toBe("changed-upstream");
  await click("Save model alias");
  expect(api.saveModelAlias).toHaveBeenLastCalledWith(
    expect.objectContaining({ revision: "2", model: "changed-upstream" }),
    "alias-1"
  );
});
