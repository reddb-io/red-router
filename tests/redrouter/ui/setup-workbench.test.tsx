// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/shared/hooks", () => ({ useDisplayBaseUrl: () => "https://router.example" }));
vi.mock("@/shared/components", async () => ({
  Badge: (await import("@/shared/components/Badge")).default,
  Button: (await import("@/shared/components/Button")).default,
  Card: (await import("@/shared/components/Card")).default,
  Input: (await import("@/shared/components/Input")).default,
  Select: (await import("@/shared/components/Select")).default,
  RecommendedSetup: ({ onApplied }: { onApplied: () => void }) => (
    <button onClick={onApplied}>Apply recommended</button>
  ),
}));
import SetupWorkbench from "@/app/(dashboard)/dashboard/SetupWorkbench";

let root: Root | null;
let container: HTMLDivElement;
let calls: { url: string; init?: RequestInit }[];
let validationResponse: () => Promise<Response>;
let inferenceResponse: () => Promise<Response>;
beforeEach(() => {
  localStorage.clear();
  calls = [];
  root = null;
  container = document.createElement("div");
  document.body.append(container);
  inferenceResponse = async () =>
    Response.json(
      { choices: [{ message: { content: "OK" } }] },
      {
        headers: { "X-OmniRoute-Selected-Connection-Id": "account" },
      }
    );
  validationResponse = async () =>
    Response.json({ status: "ready", inferenceTested: false, checks: [] });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "/api/providers")
      return Response.json({
        connections: [{ id: "account", provider: "openrouter", displayName: "Work" }],
      });
    if (url === "/api/keys" && init?.method === "POST")
      return Response.json({ id: "new-key", key: "new-secret", name: "New" });
    if (url === "/api/keys")
      return Response.json({
        keys: [{ id: "existing-key", name: "Existing", key: "masked-key", isActive: true }],
      });
    if (url.includes("/models?"))
      return Response.json({ models: [{ fullModel: "openrouter/chat" }] });
    if (url === "/api/setup/validate") return validationResponse();
    if (url === "/v1/chat/completions") return inferenceResponse();
    throw new Error(`Unexpected endpoint ${url}`);
  });
});
afterEach(() => {
  vi.useRealTimers();
  if (root) act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const mount = async () => {
  root = createRoot(container);
  await act(async () => root?.render(<SetupWorkbench />));
};
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)!;
const modelSelect = () =>
  container.querySelector<HTMLSelectElement>('select[aria-label="Client model"]')!;
const changeModel = async () => {
  await act(async () => {
    const field = modelSelect();
    field.value = "openrouter/chat";
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
const createKey = async () => {
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
};

it("existing masked keys never become a usable config or silently pass validation", async () => {
  await mount();
  await changeModel();
  expect(container.querySelector("pre")?.textContent).not.toContain("masked-key");
  expect((button("Copy config") as HTMLButtonElement).disabled).toBe(true);
  expect((button("Run validation") as HTMLButtonElement).disabled).toBe(true);
  expect(container.querySelector('a[href="/proxy/keys"]')).not.toBeNull();
});
it("checks the selected credential/model/account and sends inference only on an explicit click", async () => {
  await mount();
  await changeModel();
  await createKey();
  await act(async () => button("Run validation").click());
  const check = calls.find((call) => call.url === "/api/setup/validate")!;
  expect(JSON.parse(String(check.init?.body))).toEqual({
    connectionId: "account",
    model: "openrouter/chat",
    apiKeyId: "new-key",
    apiKey: "new-secret",
  });
  expect(calls.some((call) => call.url === "/v1/chat/completions")).toBe(false);
  expect(container.textContent).toContain("Configuration checked.");
  await act(async () => button("Send a test request").click());
  const inference = calls.find((call) => call.url === "/v1/chat/completions")!;
  expect(inference.init?.headers).toMatchObject({
    Authorization: "Bearer new-secret",
    "x-omniroute-connection": "account",
  });
  expect(JSON.parse(String(inference.init?.body))).toMatchObject({
    model: "openrouter/chat",
    stream: false,
  });
  expect(container.textContent).toContain("returned a completion");
});
it("copy completion survives feedback timeout and reload, while secrets and validation do not", async () => {
  await mount();
  await changeModel();
  await createKey();
  vi.useFakeTimers();
  await act(async () => button("Copy config").click());
  await act(async () => vi.advanceTimersByTime(1900));
  expect(
    container.querySelectorAll("ol > li")[2].querySelector('[aria-label="Complete"]')
  ).not.toBeNull();
  vi.useRealTimers();
  await act(async () => button("Run validation").click());
  const stored = localStorage.getItem("redrouter:setup:v1")!;
  expect(stored).not.toContain("new-secret");
  expect(stored).not.toContain("ready");
  act(() => root?.unmount());
  root = null;
  await mount();
  expect(container.querySelector("pre")?.textContent).not.toContain("new-secret");
  expect(container.textContent).not.toContain("Configuration checked.");
  expect(modelSelect().value).toBe("openrouter/chat");
});
it("a validation result from an old selection is ignored", async () => {
  let resolve!: (response: Response) => void;
  validationResponse = () =>
    new Promise((done) => {
      resolve = done;
    });
  await mount();
  await changeModel();
  await createKey();
  await act(async () => button("Run validation").click());
  await act(async () => {
    const field = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Client API key"]'
    )!;
    field.value = "existing-key";
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => resolve(Response.json({ status: "ready", checks: [] })));
  expect(container.textContent).not.toContain("Configuration checked.");
});
it("server markup hydrates without mismatches before browser-only progress is restored", async () => {
  const recoverable = vi.fn();
  container.innerHTML = renderToString(<SetupWorkbench />);
  await act(async () => {
    root = hydrateRoot(container, <SetupWorkbench />, { onRecoverableError: recoverable });
  });
  expect(recoverable).not.toHaveBeenCalled();
});

it("a fallback completion cannot validate the chosen provider account", async () => {
  inferenceResponse = async () =>
    Response.json(
      { choices: [{ message: { content: "OK" } }] },
      {
        headers: { "X-OmniRoute-Selected-Connection-Id": "different-account" },
      }
    );
  await mount();
  await changeModel();
  await createKey();
  await act(async () => button("Send a test request").click());
  expect(container.textContent).not.toContain("returned a completion");
  expect(container.textContent).toContain("did not return a confirmed completion");
  const inference = calls.find((call) => call.url === "/v1/chat/completions")!;
  expect(inference.init?.headers).toMatchObject({ "x-omniroute-no-cache": "true" });
});
