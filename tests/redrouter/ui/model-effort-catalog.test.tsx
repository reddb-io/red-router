// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ModelEffortCatalogTab from "@/app/(dashboard)/dashboard/settings/components/ModelEffortCatalogTab";

let root: Root;
let container: HTMLDivElement;
let writes: unknown[];
let effectiveValue: string;
let failRead: boolean;
let failSave: boolean;
const FLAG = "OMNIROUTE_DISABLE_THINKING_LEVEL_VARIANTS";

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  writes = [];
  effectiveValue = "true";
  failRead = false;
  failSave = false;
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method) {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      if (failSave) return Response.json({}, { status: 403 });
      effectiveValue = body.value;
      return Response.json({ key: FLAG, effectiveValue, source: "db" });
    }
    if (failRead) return Response.json({}, { status: 401 });
    return Response.json({ flags: [{ key: FLAG, effectiveValue, source: "default" }] });
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === text)!;
const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"]')!;

it("uses a positive compatibility label and saves only on explicit action", async () => {
  await act(async () => root.render(<ModelEffortCatalogTab />));
  expect(toggle().getAttribute("aria-label")).toBe("Show effort aliases for older clients");
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  await act(async () => toggle().click());
  expect(writes).toEqual([]);
  await act(async () => button("Save catalog settings").click());
  expect(writes).toEqual([{ key: FLAG, value: "false" }]);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved.");
  await act(async () => toggle().click());
  await act(async () => button("Save catalog settings").click());
  expect(writes[1]).toEqual({ key: FLAG, value: "true" });
});

it("honors an existing operator override without writing on mount", async () => {
  effectiveValue = "false";
  await act(async () => root.render(<ModelEffortCatalogTab />));
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(writes).toEqual([]);
  expect(button("Save catalog settings").disabled).toBe(true);
});

it("keeps an unsuccessful edit retryable without claiming it was saved", async () => {
  await act(async () => root.render(<ModelEffortCatalogTab />));
  await act(async () => toggle().click());
  failSave = true;
  await act(async () => button("Save catalog settings").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Unable to save");
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(button("Save catalog settings").disabled).toBe(false);
  failSave = false;
  await act(async () => button("Save catalog settings").click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(writes).toHaveLength(2);
});

it("a failed read disables changes and supports retry", async () => {
  failRead = true;
  await act(async () => root.render(<ModelEffortCatalogTab />));
  expect(toggle().disabled).toBe(true);
  expect(button("Save catalog settings").disabled).toBe(true);
  expect(writes).toEqual([]);
  failRead = false;
  await act(async () => button("Retry loading").click());
  expect(toggle().disabled).toBe(false);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
