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
let noModels = false;
let connectionDisabled = false;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  urls = [];
  broken = false;
  noModels = false;
  connectionDisabled = false;
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
      models: noModels ? [] : [{ id: "gpt-6-astra", name: "GPT-6 Astra" }],
      targets: url.includes("model=")
        ? [
            {
              id: "openai/gpt-6-astra",
              provider: "openai",
              position: 1,
              upstreamModel: "gpt-6-astra",
              supportedEndpoints: ["/v1/chat/completions"],
            },
          ]
        : [],
      effectivePolicy: {
        rows: [
          {
            id: "model-visibility",
            setting: "Model visibility",
            value: "Provider prefixes hidden",
            source: "Owner pin for this tenant",
            explanation: "Authorized catalog",
          },
        ],
        access: {
          modelAccessMode: "restricted",
          allowedModels: ["openai/gpt-6-astra"],
          blockedModels: [],
          allowedEndpoints: [],
        },
        connectionSource: "Tenant boundary",
        connections: [
          {
            id: "account",
            provider: "openai",
            name: "Acme account",
            enabled: !connectionDisabled,
            cooldownUntil: "2030-01-01T00:00:00Z",
            testStatus: "unavailable",
          },
        ],
      },
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
  await change(2, "gpt-6-astra");
  expect(container.textContent).toContain("1. openai/gpt-6-astra");
  expect(container.textContent).toContain("Resolved upstream model: gpt-6-astra");
  expect(container.textContent).toContain("Advertised endpoints: /v1/chat/completions");
  expect(container.textContent).toContain("Owner pin for this tenant");
  expect(container.textContent).toContain("Cooling down until");
  expect(container.textContent).toContain("Recorded status: unavailable");
  broken = true;
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((b) => b.textContent === "Refresh preview")!
      .click()
  );
  expect(container.textContent).not.toContain("1. openai/gpt-6-astra");
  expect(container.textContent).not.toContain("Acme account");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Catalog unavailable");
});

it("opens with the key selected from key routing navigation", async () => {
  await act(async () => root.render(<RoutingPreview initialApiKeyId="a-key" />));
  expect(container.querySelector("select")?.value).toBe("a-key");
  expect(urls.filter((url) => url.includes("preview"))).toHaveLength(1);
  expect(urls.at(-1)).toContain("apiKeyId=a-key");
});

it("explains an empty decision catalog without offering an unusable model selector", async () => {
  noModels = true;
  await act(async () => root.render(<RoutingPreview initialApiKeyId="a-key" />));
  await change(1, "decision");
  expect(container.querySelectorAll("select")[2].disabled).toBe(true);
  expect(container.textContent).toContain("No decision models are visible in this scope.");
  expect(container.textContent).toContain(
    "Check enabled connections, model activation and API-key permissions."
  );
});

it("keeps manual disablement distinct from a cooldown expiry", async () => {
  connectionDisabled = true;
  await act(async () => root.render(<RoutingPreview initialApiKeyId="a-key" />));
  expect(container.textContent).toContain("Disabled · Cooldown until");
  expect(container.textContent).not.toContain("Disabled until");
});
