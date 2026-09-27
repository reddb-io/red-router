// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import BuilderIntelligentStep from "../../../src/app/(dashboard)/dashboard/combos/BuilderIntelligentStep";
import { DEFAULT_INTELLIGENT_WEIGHTS } from "../../../src/lib/combos/intelligentRouting";

afterEach(cleanup);

it("a manual reset slider edit selects custom weights and retains unrelated config", () => {
  const onChange = vi.fn();
  const t = Object.assign((key: string) => key, { has: () => false });
  render(
    <BuilderIntelligentStep
      t={t}
      activeProviders={[]}
      config={{
        modePack: "ship-fast",
        weights: DEFAULT_INTELLIGENT_WEIGHTS,
        resetWindowWindows: ["weekly"],
      }}
      onChange={onChange}
    />
  );
  const slider = screen
    .getByText("Reset Window")
    .closest("div")
    ?.parentElement?.querySelector("input");
  expect(slider).toBeTruthy();
  fireEvent.change(slider!, { target: { value: "0.3" } });
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      modePack: "custom",
      resetWindowWindows: ["weekly"],
      weights: expect.objectContaining({ resetWindowAffinity: 0.3 }),
    })
  );
});

it("exposes opt-in System One settings without changing scoring or unrelated config", () => {
  const onChange = vi.fn();
  const t = Object.assign((key: string) => key, { has: () => false });
  render(
    <BuilderIntelligentStep
      t={t}
      activeProviders={[]}
      config={{
        modePack: "ship-fast",
        decision: { mode: "off", toolMode: "hint", customField: "keep" },
        resetWindowWindows: ["weekly"],
      }}
      onChange={onChange}
    />
  );

  expect(screen.getByLabelText("System One evaluation")).toHaveValue("off");
  expect(screen.getByLabelText("System One model choice")).toHaveValue("off");
  fireEvent.change(screen.getByLabelText("System One evaluation"), { target: { value: "jev" } });
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({
      modePack: "ship-fast",
      resetWindowWindows: ["weekly"],
      decision: { mode: "jev", toolMode: "hint", customField: "keep" },
    })
  );
});

it("adds a per-model JEV brief without dropping other decision settings", () => {
  const onChange = vi.fn();
  const t = Object.assign((key: string) => key, { has: () => false });
  render(
    <BuilderIntelligentStep
      t={t}
      activeProviders={[]}
      config={{ decision: { mode: "jev", modelMode: "jev", toolMode: "hint" } }}
      onChange={onChange}
    />
  );
  fireEvent.change(screen.getByLabelText("JEV brief model ID"), {
    target: { value: "example/unknown-model" },
  });
  fireEvent.change(screen.getByLabelText("JEV brief description"), {
    target: { value: "Use for short legal summaries." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add brief" }));
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({
      decision: {
        mode: "jev",
        modelMode: "jev",
        toolMode: "hint",
        briefs: { "example/unknown-model": "Use for short legal summaries." },
      },
    })
  );
});
