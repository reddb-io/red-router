// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
import RoutingProfilesEditor from "@/app/(dashboard)/dashboard/settings/components/RoutingProfilesEditor";

let container: HTMLElement;
let root: Root;
let fail = false;
const writes: { method?: string; body?: string }[] = [];
const changed = vi.fn(async () => {});
const editing = vi.fn();
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  writes.length = 0;
  fail = false;
  changed.mockClear();
  editing.mockClear();
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    writes.push({ method: init.method, body: String(init.body ?? "") });
    return fail
      ? Response.json({ error: { message: "Profile is still attached." } }, { status: 409 })
      : Response.json({ profile: { id: "p" } });
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const click = async (text: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === text
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
};
const mount = async (attachments = 0, disabled = false) => {
  await act(async () =>
    root.render(
      <RoutingProfilesEditor
        profiles={[
          {
            id: "p",
            name: "Shared",
            transparent: false,
            providerPriority: ["openrouter"],
            attachments,
          },
        ]}
        providers={[{ id: "openrouter", name: "OpenRouter", connections: 1 }]}
        onChanged={changed}
        onEditingChange={editing}
        disabled={disabled}
      />
    )
  );
};

it("edits a live profile through one management request with explicit shared impact", async () => {
  await mount(2);
  await click("Edit Shared");
  expect(container.textContent).toContain("Saving updates every attachment");
  expect(editing).toHaveBeenCalledWith(true);
  await click("Save profile");
  expect(JSON.parse(writes[0].body!)).toEqual({
    name: "Shared",
    transparent: false,
    providerPriority: ["openrouter"],
  });
  expect(writes[0].method).toBe("PUT");
  expect(changed).toHaveBeenCalledOnce();
  expect(editing).toHaveBeenLastCalledWith(false);
});

it("blocks deletion of an attached profile and displays attachment count", async () => {
  await mount(2);
  const remove = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === "Delete Shared"
  )!;
  expect(remove.disabled).toBe(true);
  expect(container.textContent).toContain("2 attachments");
});

it("retains the edit draft and error when the server rejects the write", async () => {
  await mount();
  await click("Edit Shared");
  fail = true;
  await click("Save profile");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Profile is still attached."
  );
  expect(container.querySelector("input")?.value).toBe("Shared");
  expect(changed).not.toHaveBeenCalled();
});

it("cancel sends no mutation and a new unnamed profile cannot be saved", async () => {
  await mount();
  await click("New profile");
  expect(
    [...container.querySelectorAll("button")].find(
      (element) => element.textContent === "Save profile"
    )?.disabled
  ).toBe(true);
  await click("Cancel");
  expect(writes).toHaveLength(0);
  expect(editing).toHaveBeenLastCalledWith(false);
});

it("protects pending routing changes from a profile reload", async () => {
  await mount(0, true);
  expect(container.querySelector("fieldset")?.disabled).toBe(true);
  expect(container.textContent).toContain("Save your pending routing changes");
});
