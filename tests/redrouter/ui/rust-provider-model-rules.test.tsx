// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import ProviderModelRules from "../../../rust-dashboard/ProviderModelRules";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ providerModelRules: vi.fn() }));
vi.mock("../../../rust-dashboard/api/browserClient", () => api);
afterEach(() => { document.body.innerHTML = ""; vi.resetAllMocks(); });

it("loads and saves per-account exclusions with the last revision", async () => {
  api.providerModelRules.mockResolvedValueOnce({ excluded_models: ["old-*"], revision: "1" })
    .mockResolvedValueOnce({ excluded_models: ["new-*", "private/model"], revision: "2" });
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<ProviderModelRules id="account-a" />); });
  expect(api.providerModelRules).toHaveBeenCalledWith("account-a");
  const textarea = container.querySelector("textarea")!;
  expect(textarea.value).toBe("old-*");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "new-*\nprivate/model");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { [...container.querySelectorAll("button")].find((b) => b.textContent === "Save exclusions")?.click(); });
  expect(api.providerModelRules).toHaveBeenLastCalledWith("account-a", { excluded_models: ["new-*", "private/model"], revision: "1" });
  expect(container.textContent).toContain("Model exclusions saved.");
  act(() => root.unmount());
});
