// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
import RoutingPreview from "@/shared/components/routing/RoutingPreview";
let root: Root;
let container: HTMLElement;
let urls: string[];
let broken = false;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  urls = [];
  broken = false;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === "/api/tenants/resources")
      return Response.json({
        apiKeys: [
          { id: "a-key", name: "Acme key", tenantId: "a" },
          { id: "b-key", name: "Other key", tenantId: "b" },
        ],
      });
    if (broken)
      return Response.json({ error: { message: "Catalog unavailable" } }, { status: 503 });
    return Response.json({
      policy: {
        transparent: false,
        providerPriority: ["openai"],
        source: { transparent: "owner", providerPriority: "tenant" },
      },
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
      targets: url.includes("model=")
        ? [{ id: "openai/gpt-4o", provider: "openai", position: 1 }]
        : [],
      note: "Live budgets checked at dispatch.",
    });
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const change = async (index: number, value: string) => {
  await act(async () => {
    const select = container.querySelectorAll("select")[index];
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
it("limits key choices to the tenant and previews only a selected key's catalog", async () => {
  await act(async () => root.render(<RoutingPreview tenantId="a" />));
  expect(container.textContent).not.toContain("Other key");
  expect(urls.filter((url) => url.includes("preview")).length).toBe(0);
  await change(0, "a-key");
  expect(urls.at(-1)).toContain("apiKeyId=a-key");
  await change(2, "gpt-4o");
  expect(container.textContent).toContain("1. openai/gpt-4o");
  broken = true;
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((b) => b.textContent === "Refresh preview")!
      .click()
  );
  expect(container.textContent).not.toContain("1. openai/gpt-4o");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Catalog unavailable");
});
