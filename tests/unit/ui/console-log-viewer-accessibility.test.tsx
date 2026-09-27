// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const copyToClipboard = vi.fn();

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

vi.mock("@/shared/utils/clipboard", () => ({ copyToClipboard }));

const roots: Root[] = [];

async function renderViewer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);

  const { default: ConsoleLogViewer } =
    await import("../../../src/shared/components/ConsoleLogViewer");

  await act(async () => {
    root.render(<ConsoleLogViewer />);
    await Promise.resolve();
  });
  await act(async () => {
    vi.advanceTimersByTime(0);
    await Promise.resolve();
  });

  return container;
}

describe("ConsoleLogViewer accessibility", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    copyToClipboard.mockResolvedValue(true);
    localStorage.clear();
    vi.useFakeTimers();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          timestamp: "2026-08-26T00:00:00.000Z",
          level: "info",
          message: "ready",
        },
        {
          timestamp: "2026-08-26T00:00:01.000Z",
          level: "warn",
          message: "waiting",
        },
      ],
    });
  });

  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => root.unmount());
    }
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("names icon-only controls and exposes keyboard-visible copy feedback", async () => {
    const container = await renderViewer();
    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="common.refresh"]'
    );
    const copy = container.querySelector<HTMLButtonElement>(
      'button[aria-label="logs.consoleViewer.copyLogEntry"]'
    );

    expect(refresh).not.toBeNull();
    expect(refresh?.querySelector(".material-symbols-outlined")?.getAttribute("aria-hidden")).toBe(
      "true"
    );
    expect(copy).not.toBeNull();
    expect(copy?.className).toContain("focus-visible:opacity-100");
    expect(copy?.querySelector(".material-symbols-outlined")?.getAttribute("aria-hidden")).toBe(
      "true"
    );

    await act(async () => {
      copy?.click();
      await Promise.resolve();
    });

    const status = container.querySelector('[role="status"][aria-live="polite"]');
    expect(status?.textContent).toBe("common.copied");
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("keeps the latest copy announcement for its full timeout", async () => {
    const container = await renderViewer();
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="logs.consoleViewer.copyLogEntry"]'
    );
    expect(buttons).toHaveLength(2);

    await act(async () => {
      buttons[0].click();
      await Promise.resolve();
      vi.advanceTimersByTime(1000);
      buttons[1].click();
      await Promise.resolve();
      vi.advanceTimersByTime(1000);
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("common.copied");

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("clears pending copy feedback when unmounted", async () => {
    const container = await renderViewer();
    const copy = container.querySelector<HTMLButtonElement>(
      'button[aria-label="logs.consoleViewer.copyLogEntry"]'
    );

    await act(async () => {
      copy?.click();
      await Promise.resolve();
    });

    const root = roots.pop();
    act(() => root?.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("filters by an activity minute and clears the filter on a second click", async () => {
    vi.setSystemTime(new Date("2026-08-26T00:00:30.000Z"));
    const container = await renderViewer();
    const minute = container.querySelector<HTMLButtonElement>(
      '[role="group"][aria-label="Log lines per minute"] button[aria-label$="2 lines"]'
    );

    expect(minute).not.toBeNull();
    await act(async () => minute?.click());
    expect(minute?.getAttribute("aria-pressed")).toBe("true");
    expect(
      container.querySelectorAll('button[aria-label="logs.consoleViewer.copyLogEntry"]')
    ).toHaveLength(2);

    await act(async () => minute?.click());
    expect(minute?.getAttribute("aria-pressed")).toBe("false");
  });

  it("pauses auto-scroll when browsing older lines and resumes at the bottom", async () => {
    const container = await renderViewer();
    const output = container.querySelector<HTMLDivElement>('[role="log"]');
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[title="logs.consoleViewer.disableAutoScroll"]'
    );
    expect(output).not.toBeNull();
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");

    Object.defineProperty(output, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(output, "clientHeight", { configurable: true, value: 200 });
    await act(async () => output?.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");

    if (output) output.scrollTop = 800;
    await act(async () => output?.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not intercept fullscreen shortcuts outside the console", async () => {
    const container = await renderViewer();
    const frame = container.firstElementChild as HTMLDivElement;
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(frame, "requestFullscreen", { value: requestFullscreen });

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
    expect(requestFullscreen).not.toHaveBeenCalled();

    await act(async () => {
      frame.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
      await Promise.resolve();
    });
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it("copies the currently visible console lines as text", async () => {
    const container = await renderViewer();
    const copyShown = container.querySelector<HTMLButtonElement>(
      'button[aria-label="common.copy"]'
    );

    expect(copyShown?.disabled).toBe(false);
    await act(async () => {
      copyShown?.click();
      await Promise.resolve();
    });

    const copiedText = copyToClipboard.mock.lastCall?.[0] as string;
    expect(copiedText).toContain("ready");
    expect(copiedText).toContain("waiting");
    expect(copiedText.split("\n")).toHaveLength(2);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("common.copied");
    expect(container.querySelector('button[aria-label="logs.export"]')).not.toBeNull();
  });

  it("restores legacy level, timestamp, and wrapping preferences on the Pino viewer", async () => {
    localStorage.setItem(
      "rr.consoleLog.prefs",
      JSON.stringify({ timestamps: false, wrap: true, levels: ["warn"] })
    );
    const container = await renderViewer();
    const levels = container.querySelector(
      '[role="group"][aria-label="logs.consoleViewer.filterByLevel"]'
    );

    expect(levels?.querySelector('button[aria-pressed="true"]')?.textContent).toBe("warn");
    expect(container.textContent).toContain("waiting");
    expect(container.textContent).not.toContain("ready");
    expect(
      container.querySelector('button[aria-label="Show timestamps"]')?.getAttribute("aria-pressed")
    ).toBe("false");
    expect(
      container.querySelector('button[aria-label="Wrap long lines"]')?.getAttribute("aria-pressed")
    ).toBe("true");
    expect(container.querySelector('[role="log"] .whitespace-pre-wrap')).not.toBeNull();

    const copyShown = container.querySelector<HTMLButtonElement>(
      'button[aria-label="common.copy"]'
    );
    await act(async () => {
      copyShown?.click();
      await Promise.resolve();
    });
    const copiedText = copyToClipboard.mock.lastCall?.[0] as string;
    expect(copiedText).toContain("waiting");
    expect(copiedText).not.toContain("2026-08-26T");
  });

  it("saves independent level choices and ignores malformed legacy preferences", async () => {
    localStorage.setItem("rr.consoleLog.prefs", "not-json");
    const container = await renderViewer();
    const levels = container.querySelector(
      '[role="group"][aria-label="logs.consoleViewer.filterByLevel"]'
    );
    expect(levels?.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(4);

    const info = [...(levels?.querySelectorAll("button") || [])].find(
      (button) => button.textContent === "info"
    );
    await act(async () => info?.click());
    expect(container.textContent).not.toContain("ready");
    expect(container.textContent).toContain("waiting");
    expect(JSON.parse(localStorage.getItem("rr.consoleLog.prefs") || "{}").levels).not.toContain(
      "info"
    );
  });

  it("uses structured log snapshots and appends from the live stream", async () => {
    class MockEventSource {
      static latest: MockEventSource | null = null;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      close = vi.fn();

      constructor(readonly url: string) {
        MockEventSource.latest = this;
      }
    }
    vi.stubGlobal("EventSource", MockEventSource);

    const container = await renderViewer();
    const source = MockEventSource.latest;
    expect(source?.url).toContain("/api/logs/console/stream");
    expect(globalThis.fetch).not.toHaveBeenCalled();

    await act(async () => {
      source?.onmessage?.({
        data: JSON.stringify({
          type: "snapshot",
          logs: [{ timestamp: "2026-08-26T00:00:00.000Z", level: "info", message: "first" }],
        }),
      } as MessageEvent);
    });
    expect(container.textContent).toContain("first");

    await act(async () => {
      source?.onmessage?.({
        data: JSON.stringify({
          type: "append",
          logs: [{ timestamp: "2026-08-26T00:00:01.000Z", level: "warn", message: "second" }],
        }),
      } as MessageEvent);
    });
    expect(
      container.querySelectorAll('button[aria-label="logs.consoleViewer.copyLogEntry"]')
    ).toHaveLength(2);

    const root = roots.pop();
    act(() => root?.unmount());
    expect(source?.close).toHaveBeenCalledOnce();
  });

  it("does not overwrite a newer stream snapshot with an older polling response", async () => {
    class MockEventSource {
      static latest: MockEventSource | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      close = vi.fn();

      constructor() {
        MockEventSource.latest = this;
      }
    }
    vi.stubGlobal("EventSource", MockEventSource);
    let finishFetch: ((value: unknown) => void) | undefined;
    globalThis.fetch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishFetch = resolve;
        })
    );

    const container = await renderViewer();
    await act(async () => {
      vi.advanceTimersByTime(3_001);
    });
    expect(globalThis.fetch).toHaveBeenCalledOnce();

    await act(async () => {
      MockEventSource.latest?.onmessage?.({
        data: JSON.stringify({
          type: "snapshot",
          logs: [{ timestamp: "2026-08-26T00:00:01.000Z", level: "info", message: "new" }],
        }),
      } as MessageEvent);
    });
    await act(async () => {
      finishFetch?.({
        ok: true,
        json: async () => [
          { timestamp: "2026-08-26T00:00:00.000Z", level: "info", message: "stale" },
        ],
      });
      await Promise.resolve();
    });
    expect(container.textContent).toContain("new");
    expect(container.textContent).not.toContain("stale");
  });
});
