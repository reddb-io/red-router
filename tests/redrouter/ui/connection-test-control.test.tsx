// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ConnectionTestControl from "@/app/(dashboard)/dashboard/providers/[id]/components/modals/ConnectionTestControl";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const clickTest = async () =>
  act(async () => container.querySelector<HTMLButtonElement>("button")!.click());

it("shows cooldown while allowing an unsaved probe and displays HTTP errors and latency", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ valid: false, error: "Invalid API key", statusCode: 401, latencyMs: 25 })
  );
  vi.stubGlobal("fetch", fetcher);
  const draft = {
    baseUrl: "http://10.101.2.111:25050/v1",
    apiKey: "replacement",
    validationModelId: "jev",
  };
  await act(async () =>
    root.render(
      <ConnectionTestControl
        connectionId="conn"
        health={{
          rateLimitedUntil: new Date(Date.now() + 60000).toISOString(),
          testStatus: "unavailable",
          lastError: "Prior error",
        }}
        draft={draft}
      />
    )
  );
  expect(container.textContent).toContain("Routing cooldown:");
  expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
  await clickTest();
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ draft });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Invalid API key");
  expect(container.textContent).toContain("HTTP 401");
  expect(container.textContent).toContain("25 ms");
});

it("does not show a success badge for a failed management HTTP response", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({ valid: true, error: "Authentication required" }, { status: 403 })
  );
  await act(async () => root.render(<ConnectionTestControl connectionId="conn" health={{}} />));
  await clickTest();
  expect(container.textContent).toContain("Test failed");
  expect(container.textContent).not.toContain("Connection reached");
});

it("changing the URL aborts the old request, clears its result and never auto-probes the new draft", async () => {
  let signal: AbortSignal;
  const fetcher = vi.fn((_input: RequestInfo | URL, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return new Promise<Response>(() => {});
  });
  vi.stubGlobal("fetch", fetcher);
  await act(async () =>
    root.render(
      <ConnectionTestControl connectionId="conn" health={{}} draft={{ baseUrl: "http://old/v1" }} />
    )
  );
  await clickTest();
  await act(async () =>
    root.render(
      <ConnectionTestControl connectionId="conn" health={{}} draft={{ baseUrl: "http://new/v1" }} />
    )
  );
  expect(signal.aborted).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
});

it("a successful saved probe updates the shown cooldown from the server response", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({ valid: true, rateLimitedUntil: null, latencyMs: 7 })
  );
  await act(async () =>
    root.render(
      <ConnectionTestControl
        connectionId="conn"
        health={{ rateLimitedUntil: new Date(Date.now() + 60000).toISOString() }}
      />
    )
  );
  await clickTest();
  expect(container.textContent).toContain("No active connection cooldown");
  expect(container.textContent).toContain("Connection reached");
});
