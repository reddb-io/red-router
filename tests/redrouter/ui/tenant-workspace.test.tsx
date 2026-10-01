// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
import TenantWorkspace from "@/app/login/TenantWorkspace";
import TenantSignIn from "@/app/login/TenantSignIn";
let root: Root;
let container: HTMLElement;
let calls: { url: string; body?: Record<string, unknown> }[];
let locked = false;
let broken = false;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  calls = [];
  locked = false;
  broken = false;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (broken) return Response.json({ error: { message: "Session expired" } }, { status: 401 });
    if (url === "/api/tenant/me")
      return Response.json({
        user: { id: "a", email: "admin@acme.test", role: "admin" },
        tenant: { name: "Acme" },
        capabilities: [],
      });
    if (url.startsWith("/api/tenant/usage?"))
      return Response.json({
        usage: {
          total: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 },
          keys: [],
          coverage: "Recorded costs are not invoices.",
          reconciliation: { total: { recordedCostUsd: null }, keys: [] },
        },
      });
    if (url === "/api/tenant/keys")
      return Response.json({
        keys: [{ id: "key", name: "Acme key", prefix: "sk-abcd", isActive: true }],
      });
    if (url === "/api/tenant/users")
      return Response.json({
        users: [{ id: "admin", email: "admin@acme.test", role: "admin", hasPassword: true }],
      });
    return Response.json({
      locked: { transparent: locked, priority: locked },
      choice: { transparent: null, priority: null },
      effective: {
        transparent: true,
        providerPriority: ["one", "two"],
        source: { transparent: "instance", providerPriority: "instance" },
      },
      providers: [
        { id: "one", name: "One", connections: 1 },
        { id: "two", name: "Two", connections: 1 },
      ],
    });
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const mount = async (node: React.ReactNode) => {
  await act(async () => root.render(node));
};
const click = async (label: string) => {
  await act(async () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === label)!.click()
  );
};
it("restores the tenant session and never asks the owner API for data", async () => {
  await mount(<TenantSignIn token={null} />);
  expect(container.textContent).toContain("Acme");
  expect(container.textContent).toContain("Unknown");
  await click("API keys");
  expect(container.textContent).toContain("sk-abcd…");
  await click("Members");
  expect(container.textContent).toContain("admin@acme.test");
  expect(calls.every((call) => call.url.startsWith("/api/tenant/"))).toBe(true);
});
it("edits only delegated choices and saves provider order from the connection-backed list", async () => {
  await mount(<TenantWorkspace role="admin" />);
  await click("Routing");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Move two up"]')!.click()
  );
  await click("Save routing");
  expect(calls.find((call) => call.body)?.body).toEqual({ priority: ["two", "one"] });
});
it("owner locks disable controls and a regular member cannot load admin data", async () => {
  locked = true;
  await mount(<TenantWorkspace role="admin" />);
  await click("Routing");
  expect(container.querySelector<HTMLSelectElement>("select")!.disabled).toBe(true);
  expect(container.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(true);
  calls = [];
  await mount(<TenantWorkspace role="user" />);
  expect(calls.length).toBe(0);
  expect(container.querySelector("table")).toBeNull();
});
it("a failed read hides previous data and offers refresh", async () => {
  await mount(<TenantWorkspace role="admin" />);
  await click("API keys");
  broken = true;
  await click("Refresh");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Session expired");
  expect(container.textContent).not.toContain("Acme key");
});
