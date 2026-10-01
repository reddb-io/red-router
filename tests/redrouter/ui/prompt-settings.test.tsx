// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SystemPromptTab from "@/app/(dashboard)/dashboard/settings/components/SystemPromptTab";
import AdditionalInstructionsCard from "@/app/(dashboard)/dashboard/settings/components/AdditionalInstructionsCard";

let root: Root;
let container: HTMLDivElement;
let writes: Array<{ method: string; body: unknown }>;
let failRead: boolean;
let failSave: boolean;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  writes = [];
  failRead = false;
  failSave = false;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method) {
      writes.push({ method: init.method, body: JSON.parse(String(init.body)) });
      return Response.json({}, { status: failSave ? 403 : 200 });
    }
    if (failRead) return Response.json({}, { status: 401 });
    return Response.json(
      String(input).endsWith("system-prompt")
        ? { enabled: true, prefixPrompt: "Existing prefix", suffixPrompt: "Existing suffix" }
        : {
            customSystemPromptEnabled: true,
            customSystemPrompt: "Existing additional text",
            unrelated: "keep",
          }
    );
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;

it("disabling prompt additions preserves loaded text and waits for explicit save", async () => {
  await act(async () => root.render(<SystemPromptTab />));
  expect(container.querySelector<HTMLTextAreaElement>("#router-prefix-prompt")?.value).toBe(
    "Existing prefix"
  );
  await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(writes).toEqual([]);
  await act(async () => button("Save prompt additions").click());
  expect(writes).toEqual([
    {
      method: "PUT",
      body: { enabled: false, prefixPrompt: "Existing prefix", suffixPrompt: "Existing suffix" },
    },
  ]);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Saved.");
});

it("the moved endpoint prompt saves only its own settings and keeps text when disabled", async () => {
  await act(async () => root.render(<AdditionalInstructionsCard />));
  await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(writes).toEqual([]);
  await act(async () => button("Save appended instructions").click());
  expect(writes).toEqual([
    {
      method: "PATCH",
      body: { customSystemPromptEnabled: false, customSystemPrompt: "Existing additional text" },
    },
  ]);
});

it("a rejected save keeps edits retryable and never claims success", async () => {
  await act(async () => root.render(<SystemPromptTab />));
  await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  failSave = true;
  await act(async () => button("Save prompt additions").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Unable to save");
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(button("Save prompt additions").disabled).toBe(false);
  failSave = false;
  await act(async () => button("Save prompt additions").click());
  expect(writes).toHaveLength(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Saved.");
});

it("a failed load prevents overwriting prompts with empty defaults and supports retry", async () => {
  failRead = true;
  await act(async () => root.render(<SystemPromptTab />));
  expect(button("Save prompt additions").disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(true);
  expect(writes).toEqual([]);
  failRead = false;
  await act(async () => button("Retry loading").click());
  expect(container.querySelector<HTMLTextAreaElement>("#router-suffix-prompt")?.value).toBe(
    "Existing suffix"
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
