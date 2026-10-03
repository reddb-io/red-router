import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useLiveRequests } from "@/hooks/useLiveDashboard";

it("an accepted reconnect discards orphaned active requests before replay and cleans up timers", async () => {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onclose?: () => void;
    onerror?: () => void;
    onmessage?: (event: { data: string }) => void;
    constructor() {
      sockets.push(this);
    }
    send() {}
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    message(message: unknown) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Harness() {
    const state = useLiveRequests({ wsUrl: "ws://localhost/live" });
    return (
      <>
        <span data-count>{state.activeCount}</span>
        <button onClick={state.reconnect}>Reconnect</button>
      </>
    );
  }
  const start = (id: string) => ({
    event: "request.started",
    channel: "requests",
    timestamp: Date.now(),
    data: { id, model: "test", provider: "test", timestamp: Date.now() },
  });
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => {
      sockets[0].onopen?.();
      sockets[0].message({ type: "welcome", data: [] });
      sockets[0].message({ type: "event", ...start("lost-completion") });
    });
    expect(container.querySelector("[data-count]")!.textContent).toBe("1");
    await act(async () => container.querySelector("button")!.click());
    expect(sockets).toHaveLength(2);
    await act(async () => {
      sockets[1].onopen?.();
      sockets[1].message({ type: "welcome", data: [start("fresh-request")] });
    });
    expect(container.querySelector("[data-count]")!.textContent).toBe("1");
    await act(async () =>
      sockets[1].message({
        type: "event",
        event: "request.completed",
        channel: "requests",
        timestamp: Date.now(),
        data: { id: "fresh-request", status: "success" },
      })
    );
    expect(container.querySelector("[data-count]")!.textContent).toBe("0");
  } finally {
    act(() => root.unmount());
    container.remove();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
