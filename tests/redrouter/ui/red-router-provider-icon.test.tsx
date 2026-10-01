// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/shared/hooks/useTheme", () => ({ useTheme: () => ({ isDark: true }) }));
vi.mock("@/shared/components/lobeProviderIcons", () => ({ getLobeProviderIcon: () => null }));
import ProviderIcon from "@/shared/components/ProviderIcon";
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
});
it("RedRouter and red aliases render the local RedDB logo while honoring operator overrides", async () => {
  for (const providerId of ["red-router", "red", "redrouter"]) {
    await act(async () => root.render(<ProviderIcon providerId={providerId} />));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/providers/red-router.svg");
  }
  await act(async () =>
    root.render(<ProviderIcon providerId="red-router" src="https://example.test/custom.svg" />)
  );
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    "https://example.test/custom.svg"
  );
});
