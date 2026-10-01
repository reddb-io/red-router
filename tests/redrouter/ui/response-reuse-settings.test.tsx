// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("next-intl", () => {
  const translate = (key: string) => key;
  return { useTranslations: () => translate };
});
import CacheSettingsTab from "@/app/(dashboard)/dashboard/settings/components/CacheSettingsTab";
let root: Root;
let container: HTMLElement;
let writes: Record<string, unknown>[];
let broken: boolean;
let saved: Record<string, unknown>;
const model = "openrouter/typesafe/jev-1.13";
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  writes = [];
  broken = false;
  saved = {
    semanticCacheEnabled: true,
    semanticCacheVectorEnabled: false,
    modelCatalogCacheTtlMs: 1000,
    embeddingOptions: [],
    verificationOptions: [
      {
        id: "openrouter-key",
        name: "My OpenRouter",
        provider: "openrouter",
        models: [{ id: model, name: "JEV" }],
      },
    ],
  };
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (broken) return Response.json({ error: "Service unavailable" }, { status: 503 });
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      saved = { ...saved, ...body };
      return Response.json({ ok: true });
    }
    return Response.json(saved);
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const mount = async () => {
  await act(async () => root.render(<CacheSettingsTab />));
};
const select = async (id: string, value: string) => {
  await act(async () => {
    const input = container.querySelector<HTMLSelectElement>(`#${id}`)!;
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;

it("starts with identical reuse, progressively selects a connection then a decision model, and saves off", async () => {
  await mount();
  expect(container.querySelector<HTMLSelectElement>("#response-reuse-policy")!.value).toBe("exact");
  expect(container.querySelector("#cache-embedding-provider")).toBeNull();
  await select("response-reuse-policy", "verified");
  expect(button("Save response reuse").disabled).toBe(true);
  expect(container.querySelector<HTMLSelectElement>("#cache-verification-model")!.disabled).toBe(
    true
  );
  await select("cache-verification-connection", "openrouter-key");
  expect(container.querySelector<HTMLSelectElement>("#cache-verification-model")!.value).toBe("");
  expect(container.textContent).toContain("JEV");
  await select("cache-verification-model", model);
  expect(button("Save response reuse").disabled).toBe(false);
  await act(async () => button("Save response reuse").click());
  expect(writes[0]).toMatchObject({
    semanticCacheEnabled: true,
    semanticCacheVectorEnabled: true,
    semanticCacheVerificationEnabled: true,
    semanticCacheVerificationConnectionId: "openrouter-key",
    semanticCacheVerificationModel: model,
  });
  await select("response-reuse-policy", "off");
  expect(container.querySelector("#cache-verification-connection")).toBeNull();
  await act(async () => button("Save response reuse").click());
  expect(writes[1]).toMatchObject({
    semanticCacheEnabled: false,
    semanticCacheVectorEnabled: false,
    semanticCacheVerificationEnabled: false,
  });
});

it("preserves existing unverified similarity settings and hides unrelated decision controls", async () => {
  saved.semanticCacheVectorEnabled = true;
  await mount();
  expect(container.querySelector<HTMLSelectElement>("#response-reuse-policy")!.value).toBe(
    "similar"
  );
  expect(container.querySelector("#cache-verification-connection")).toBeNull();
  await act(async () => button("Save response reuse").click());
  expect(writes[0].semanticCacheVerificationEnabled).toBe(false);
});

it("stale decision configuration blocks verified saving but never blocks turning reuse off", async () => {
  saved = {
    ...saved,
    semanticCacheVectorEnabled: true,
    semanticCacheVerificationEnabled: true,
    semanticCacheVerificationConnectionId: "deleted",
    semanticCacheVerificationModel: model,
  };
  await mount();
  expect(container.textContent).toContain("Saved connection unavailable");
  expect(button("Save response reuse").disabled).toBe(true);
  await select("response-reuse-policy", "exact");
  await act(async () => button("Save response reuse").click());
  expect(writes[0]).toMatchObject({
    semanticCacheVectorEnabled: false,
    semanticCacheVerificationEnabled: false,
  });
});

it("failed settings loads cannot overwrite saved configuration and can be retried", async () => {
  broken = true;
  await mount();
  expect(button("Save response reuse").disabled).toBe(true);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be loaded");
  expect(writes).toHaveLength(0);
  broken = false;
  await act(async () => button("Retry loading settings").click());
  expect(button("Save response reuse").disabled).toBe(false);
});
