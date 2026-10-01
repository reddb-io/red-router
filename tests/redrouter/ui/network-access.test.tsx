// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import NetworkAccessCard from "@/app/(dashboard)/dashboard/settings/components/NetworkAccessCard";
let root: Root;
let container: HTMLElement;
let writes: unknown[];
let saved: boolean;
let reads: number;
let confirm: boolean;
let loadError: boolean;
let postError: boolean;
let canApply: boolean;
const state = (lan = false) => ({
  host: lan ? "0.0.0.0" : "127.0.0.1",
  port: 25050,
  mode: lan ? "lan" : "local",
  configuredHost: saved ? "0.0.0.0" : "127.0.0.1",
  managed: true,
  canApply,
  pendingRestart: saved && !lan,
  restartError: null,
  addresses: [
    {
      address: "10.101.2.111",
      dashboardUrl: "http://10.101.2.111:25050",
      apiBaseUrl: "http://10.101.2.111:25050/v1",
      healthUrl: "http://10.101.2.111:25050/healthz",
    },
  ],
});
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  writes = [];
  saved = false;
  reads = 0;
  confirm = true;
  loadError = false;
  postError = false;
  canApply = true;
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)));
      if (postError)
        return Response.json(
          { error: { message: "Service configuration changed. Reload settings before retrying." } },
          { status: 409 }
        );
      saved = true;
      return Response.json(state(), { status: 202 });
    }
    if (loadError) return Response.json({ error: "offline" }, { status: 503 });
    if (saved) reads++;
    return Response.json(state(saved && confirm && reads >= 2));
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount() {
  await act(async () => root.render(<NetworkAccessCard />));
}
function button(label: string) {
  return [...container.querySelectorAll("button")].find((entry) => entry.textContent === label)!;
}
async function selectLan() {
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>("#network-access-mode")!;
    select.value = "lan";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
it("requires explicit apply and verifies the live listener before reporting network access enabled", async () => {
  await mount();
  await selectLan();
  expect(writes).toHaveLength(0);
  expect(container.textContent).toContain("http://10.101.2.111:25050/v1");
  await act(async () => button("Apply and restart").click());
  expect(writes).toEqual([{ mode: "lan" }]);
  expect(container.textContent).not.toContain("Local network access is enabled.");
  expect(container.textContent).toContain("127.0.0.1:25050");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(container.textContent).toContain("Local network access is enabled.");
  expect(container.textContent).toContain("0.0.0.0:25050");
});
it("shows service errors without claiming the listener changed", async () => {
  postError = true;
  await mount();
  await selectLan();
  await act(async () => button("Apply and restart").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Service configuration changed"
  );
  expect(container.textContent).toContain("127.0.0.1:25050");
  expect(container.textContent).not.toContain("Local network access is enabled.");
});
it("does not call a saved but unconfirmed restart a success", async () => {
  confirm = false;
  await mount();
  await selectLan();
  await act(async () => button("Apply and restart").click());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120000);
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Restart is not confirmed"
  );
  expect(container.textContent).not.toContain("Local network access is enabled.");
});
it("remote dashboards explain how to change the local service and keep the apply control disabled", async () => {
  canApply = false;
  await mount();
  expect(container.querySelector<HTMLSelectElement>("#network-access-mode")?.disabled).toBe(true);
  expect(button("Apply and restart").disabled).toBe(true);
  expect(container.textContent).toContain("http://localhost:25050/dashboard/settings/security");
});
it("a failed load leaves settings disabled and can be retried", async () => {
  loadError = true;
  await mount();
  expect(button("Apply and restart").disabled).toBe(true);
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  loadError = false;
  await act(async () => button("Reload status").click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector<HTMLSelectElement>("#network-access-mode")?.disabled).toBe(false);
});
