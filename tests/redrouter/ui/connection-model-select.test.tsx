// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ConnectionModelSelect from "@/shared/components/ConnectionModelSelect";

let root: Root;
let container: HTMLDivElement;
const connections = [
  {
    id: "a",
    provider: "openrouter",
    displayName: "Work",
    email: "a@example.test",
    testStatus: "success",
  },
  { id: "b", provider: "red-router", displayName: "Remote" },
];
const onChange = vi.fn();
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onChange.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ models: [{ fullModel: "openrouter/typesafe/jev-1.13" }] }))
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = async (connectionId = "a", model = "", role: "decision" | "chat" = "decision") => {
  await act(async () =>
    root.render(
      <ConnectionModelSelect
        role={role}
        connections={connections}
        value={{ connectionId, model }}
        onChange={onChange}
      />
    )
  );
};
const select = (label: string) =>
  container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;

it("requires a connection before fetching models and never falls back to a text field", async () => {
  await render("");
  expect(fetch).not.toHaveBeenCalled();
  expect(select("System One model").disabled).toBe(true);
  expect(container.querySelector('input[type="text"]')).toBeNull();
});
it("requests decision models for the selected account and clears the model when accounts change", async () => {
  await render("a", "openrouter/typesafe/jev-1.13");
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining("/a/models?excludeHidden=true&capabilities=decision"),
    expect.anything()
  );
  expect(select("System One connection").options[1].textContent).toContain(
    "openrouter · Work · a@example.test · success"
  );
  await act(async () => {
    const input = select("System One connection");
    input.value = "b";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledWith({ connectionId: "b", model: "" });
});
it("late results from another account never appear in the current catalog", async () => {
  let resolveOld!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) =>
      String(input).includes("/a/")
        ? new Promise<Response>((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(
            Response.json({ models: [{ fullModel: "red/red/openrouter/typesafe/jev-1.13" }] })
          )
    )
  );
  await render("a");
  await render("b");
  await act(async () =>
    resolveOld(Response.json({ models: [{ fullModel: "old-account-model" }] }))
  );
  expect(select("System One model").textContent).toContain("red/red/openrouter/typesafe/jev-1.13");
  expect(select("System One model").textContent).not.toContain("old-account-model");
});
it("catalog errors show a retry and retain the saved model without accepting arbitrary text", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("unavailable", { status: 503 }))
  );
  await render("a", "saved-evaluator");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
  expect(select("System One model").disabled).toBe(true);
  expect(select("System One model").value).toBe("saved-evaluator");
  expect(container.querySelector("input")).toBeNull();
  expect(
    [...container.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Retry")
    )
  ).toBe(true);
});
it("chat selections display reasoning, tool and vision evidence", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        models: [
          {
            fullModel: "openrouter/chat",
            capabilities: { reasoning: true, tool_calling: true, vision: true },
          },
        ],
      })
    )
  );
  await render("a", "", "chat");
  expect(select("Client model").textContent).toContain("reasoning, tools, vision");
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining("capabilities=chat"),
    expect.anything()
  );
});
