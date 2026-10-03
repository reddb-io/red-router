// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SqliteHistoryRetentionControl from "@/app/(dashboard)/dashboard/settings/components/SqliteHistoryRetentionControl";

let root: Root;
let container: HTMLDivElement;
const change = vi.fn();
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  change.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("offers the four requested windows without enabling cleanup or writing on mount", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await act(async () =>
    root.render(<SqliteHistoryRetentionControl days={null} onChange={change} />)
  );
  const select = container.querySelector("select")!;
  expect(
    [...select.options].filter((option) => !option.disabled).map((option) => option.textContent)
  ).toEqual(["Off", "7 days", "14 days", "28 days"]);
  expect(select.value).toBe("existing");
  expect(container.querySelector("button")!.disabled).toBe(true);
  select.value = "14";
  await act(async () => select.dispatchEvent(new Event("change", { bubbles: true })));
  expect(change).toHaveBeenCalledWith(14);
  expect(fetch).not.toHaveBeenCalled();
});

it("Off keeps manual cleanup unavailable", async () => {
  await act(async () => root.render(<SqliteHistoryRetentionControl days={0} onChange={change} />));
  expect(container.querySelector("select")!.value).toBe("0");
  expect(container.querySelector("button")!.disabled).toBe(true);
});

it("an unsaved window is rejected visibly and cleanup can be retried after saving", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { error: { message: "Save the retention setting before running cleanup." } },
        { status: 409 }
      )
    )
    .mockResolvedValueOnce(Response.json({ success: true, deleted: 12 }));
  vi.stubGlobal("fetch", fetch);
  await act(async () => root.render(<SqliteHistoryRetentionControl days={7} onChange={change} />));
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector('[role="alert"]')!.textContent).toContain(
    "Save the retention setting"
  );
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ days: 7 });
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector('[role="status"]')!.textContent).toContain("12 history rows");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
