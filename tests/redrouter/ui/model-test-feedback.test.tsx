// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ModelTestFeedback from "@/app/(dashboard)/dashboard/providers/[id]/components/ModelTestFeedback";
import { ModelVisibilityToolbar } from "@/app/(dashboard)/dashboard/providers/[id]/components/ModelRow";
import { useModelVisibilityHandlers } from "@/app/(dashboard)/dashboard/providers/[id]/hooks/useModelVisibilityHandlers";

let container: HTMLDivElement;
let root: Root;
const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
function TestFlow({ connectionId = "connection" }: { connectionId?: string }) {
  const hook = useModelVisibilityHandlers({
    providerId: "openrouter",
    modelAliases: {},
    customMap: new Map(),
    providerStorageAlias: "openrouter",
    fetchProviderModelMeta: async () => {},
    fetchAliases: async () => {},
    notify: notify as unknown as Parameters<typeof useModelVisibilityHandlers>[0]["notify"],
    t: (key) => key,
    selectedConnection: { id: connectionId, provider: "openrouter" },
    providerNode: null,
  });
  return (
    <>
      <button onClick={() => hook.onTestModel("vendor/model", "openrouter/vendor/model")}>
        Test
      </button>
      <ModelTestFeedback result={hook.modelTestFeedback} />
      <span data-model-status>{hook.modelTestStatus["vendor/model"] ?? "untested"}</span>
    </>
  );
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("shows pending immediately, retains an HTTP failure after the toast, and replaces it on retry", async () => {
  let complete: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      })
  );
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(<TestFlow />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(container.textContent).toContain("Testing model");
  expect(container.textContent).toContain("openrouter/vendor/model");
  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
    providerId: "openrouter",
    modelId: "openrouter/vendor/model",
    connectionId: "connection",
  });
  await act(async () =>
    complete(
      Response.json(
        {
          status: "error",
          error: { message: "Model unavailable" },
          latencyMs: 12,
          statusCode: 404,
        },
        { status: 404 }
      )
    )
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Model unavailable");
  expect(container.textContent).toContain("HTTP 404 · 12 ms");
  notify.error.mockClear();
  expect(container.textContent).toContain("Model unavailable");
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(container.textContent).not.toContain("Model unavailable");
  await act(async () => complete(Response.json({ status: "ok", latencyMs: 25 })));
  expect(container.textContent).toContain("Model test passed");
  expect(container.textContent).toContain("HTTP 200 · 25 ms");
});

it("keeps a network failure visible and does not alter activation", async () => {
  const fetcher = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(<TestFlow />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.textContent).toContain("Model test failed");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("explains why a batch cannot run when the filter has no active models", async () => {
  const onTestAll = vi.fn();
  const props = {
    t: (key: string) => key,
    filterValue: "inactive",
    onFilterChange: vi.fn(),
    activeCount: 3,
    totalCount: 8,
    testableCount: 0,
    onSelectAll: vi.fn(),
    onDeselectAll: vi.fn(),
    onTestAll,
  };
  await act(async () => root.render(<ModelVisibilityToolbar {...props} />));
  const button = container.querySelector<HTMLButtonElement>(
    'button[title="No active models match the current filter"]'
  )!;
  expect(button.disabled).toBe(true);
  expect(container.textContent).toContain("individual test button without activating it");
  await act(async () => button.click());
  expect(onTestAll).not.toHaveBeenCalled();
  await act(async () =>
    root.render(
      <ModelVisibilityToolbar
        {...props}
        testableCount={2}
        testingAll
        testProgress={{ done: 1, total: 2 }}
      />
    )
  );
  expect(container.textContent).toContain("Testing 1/2");
});

it("a test stops waiting even if fetch ignores abort, shows a timeout and allows retry", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(<TestFlow />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
  await act(async () => vi.advanceTimersByTimeAsync(40_000));
  expect(signal.aborted).toBe(true);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Test timed out after 40 seconds"
  );
  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  fetcher.mockImplementation(async () => Response.json({ status: "ok", latencyMs: 12 }));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(container.textContent).toContain("Model test passed");
  expect(vi.getTimerCount()).toBe(0);
});

it("the client deadline covers a hung JSON body after headers arrive", async () => {
  vi.useFakeTimers();
  const response = Response.json({ status: "ok" });
  vi.spyOn(response, "json").mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal("fetch", async () => response);
  await act(async () => root.render(<TestFlow />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  await act(async () => vi.advanceTimersByTimeAsync(40_000));
  expect(container.textContent).toContain("Test timed out after 40 seconds");
  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
});

it("changing connections aborts the old test and a late response cannot overwrite the new scope", async () => {
  let finish: (response: Response) => void;
  let signal: AbortSignal;
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  await act(async () => root.render(<TestFlow />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  await act(async () => root.render(<TestFlow connectionId="other" />));
  expect(signal.aborted).toBe(true);
  await act(async () => finish(Response.json({ status: "ok", latencyMs: 1 })));
  expect(container.textContent).not.toContain("Model test passed");
  expect(notify.success).not.toHaveBeenCalled();
});

it("successful model status is scoped to the selected connection", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ status: "ok", latencyMs: 12 }));
  await act(async () => root.render(<TestFlow />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(container.querySelector("[data-model-status]")?.textContent).toBe("ok");
  await act(async () => root.render(<TestFlow connectionId="other" />));
  expect(container.querySelector("[data-model-status]")?.textContent).toBe("untested");
  expect(container.textContent).not.toContain("Model test passed");
});
