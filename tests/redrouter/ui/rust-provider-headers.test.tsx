// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import ProviderHeaders from "../../../rust-dashboard/ProviderHeaders";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => vi.fn());
const nodeApi = vi.hoisted(() => vi.fn());
vi.mock("../../../rust-dashboard/api/browserClient", () => ({
  providerRequestHeaders: api,
  providerDefinitionHeaders: nodeApi,
}));
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.resetAllMocks();
});
async function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<ProviderHeaders id="account-a" />);
  });
  return container;
}
it("keeps encrypted values out of the editor and removes only on explicit action", async () => {
  api
    .mockResolvedValueOnce({ names: ["x-title"], attached: false, revision: "1" })
    .mockResolvedValueOnce({ names: [], attached: true, revision: null });
  const container = await render();
  expect(container.textContent).toContain("These headers are inactive");
  expect(container.textContent).toContain("Additional headers for this API connection");
  expect(container.querySelector("textarea")?.value).toBe("");
  expect(api).toHaveBeenCalledTimes(1);
  const remove = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Remove all headers"
  );
  await act(async () => {
    remove?.click();
  });
  expect(api).toHaveBeenLastCalledWith("account-a", {});
  expect(container.textContent).toContain("Custom headers removed.");
});
it("retains the form and reports a storage failure instead of claiming activation", async () => {
  api
    .mockResolvedValueOnce({ names: ["x-title"], attached: true, revision: "1" })
    .mockRejectedValueOnce(new Error("Storage unavailable"));
  const container = await render();
  const remove = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Remove all headers"
  );
  await act(async () => {
    remove?.click();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Storage unavailable");
  expect(container.textContent).toContain("Configured: x-title");
  expect(container.textContent).not.toContain("Custom headers removed.");
});

it("edits shared defaults without using the account endpoint or exposing values", async () => {
  nodeApi
    .mockResolvedValueOnce({ names: ["x-project"], attached: true, revision: "1" })
    .mockResolvedValueOnce({ names: [], attached: true, revision: null });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<ProviderHeaders id="shared-gateway" scope="definition" />);
  });
  expect(container.textContent).toContain("Matching account headers take precedence");
  expect(container.querySelector("textarea")?.value).toBe("");
  expect(nodeApi).toHaveBeenCalledWith("shared-gateway");
  const remove = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Remove shared headers"
  );
  await act(async () => {
    remove?.click();
  });
  expect(nodeApi).toHaveBeenLastCalledWith("shared-gateway", {});
  expect(api).not.toHaveBeenCalled();
});
