// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const readRustAuthConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rustControlPlane/browserClient", () => ({ readRustAuthConfig }));
vi.mock("@/app/(dashboard)/dashboard/providers/RustProvidersPageClient", () => ({
  default: () => <div data-backend="rust">rust providers</div>,
}));

const { default: ProvidersBackendBoundary } =
  await import("@/app/(dashboard)/dashboard/providers/ProvidersBackendBoundary");

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function renderBoundary() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <ProvidersBackendBoundary legacy={<div data-backend="legacy">legacy providers</div>} />
    );
    await Promise.resolve();
  });
  return container;
}

describe("provider backend boundary", () => {
  it("selects the Rust provider authority when the Rust control plane is active", async () => {
    readRustAuthConfig.mockResolvedValue({ control_plane_enabled: true });
    const container = await renderBoundary();
    expect(container.querySelector('[data-backend="rust"]')).not.toBeNull();
    expect(container.querySelector('[data-backend="legacy"]')).toBeNull();
  });

  it("keeps the legacy provider manager when Rust is unavailable", async () => {
    readRustAuthConfig.mockRejectedValue(new Error("unavailable"));
    const container = await renderBoundary();
    expect(container.querySelector('[data-backend="legacy"]')).not.toBeNull();
    expect(container.querySelector('[data-backend="rust"]')).toBeNull();
  });
});
