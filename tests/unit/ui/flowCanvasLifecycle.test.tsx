// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const flow = vi.hoisted(() => ({
  onInit: null as null | ((instance: { fitView: () => void }) => void),
}));

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ onInit }: { onInit: typeof flow.onInit }) => {
    flow.onInit = onInit;
    return <div />;
  },
  Controls: () => null,
}));

import { FlowCanvas } from "@/shared/components/flow/FlowCanvas";

afterEach(() => {
  vi.restoreAllMocks();
  flow.onInit = null;
});

it("ignores a late React Flow initialization after the canvas unmounts", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const schedule = vi.spyOn(globalThis, "setTimeout");
  const fitView = vi.fn();

  act(() => root.render(<FlowCanvas nodes={[]} edges={[]} />));
  const onInit = flow.onInit;
  expect(onInit).toBeTypeOf("function");
  act(() => root.unmount());
  const scheduledBeforeLateInit = schedule.mock.calls.length;

  onInit?.({ fitView });

  expect(schedule.mock.calls.length).toBe(scheduledBeforeLateInit);
  expect(fitView).not.toHaveBeenCalled();
  container.remove();
});
