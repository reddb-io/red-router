// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const readRustAuthConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rustControlPlane/browserClient", () => ({ readRustAuthConfig }));
vi.mock("@/app/(dashboard)/dashboard/api-manager/ApiManagerPageClient", () => ({
  default: () => <div data-backend="legacy">legacy manager</div>,
}));
vi.mock("@/app/(dashboard)/dashboard/api-manager/RustApiManagerPageClient", () => ({
  default: () => <div data-backend="rust">rust manager</div>,
}));

const { default: ApiManagerBackendBoundary } =
  await import("@/app/(dashboard)/dashboard/api-manager/ApiManagerBackendBoundary");

const roots: Array<{ root: ReturnType<typeof createRoot>; container: HTMLDivElement }> = [];

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => {
    root.render(<ApiManagerBackendBoundary />);
    await Promise.resolve();
  });
  return container;
}

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  readRustAuthConfig.mockReset();
});

describe("API manager backend boundary", () => {
  it("selects the hash-only Rust key authority when red-routerd owns the control plane", async () => {
    readRustAuthConfig.mockResolvedValue({
      backend: "rust",
      control_plane_enabled: true,
      oidc_browser_login: true,
      password_login: false,
    });
    const container = await mount();
    expect(container.querySelector('[data-backend="rust"]')).not.toBeNull();
    expect(container.querySelector('[data-backend="legacy"]')).toBeNull();
  });

  it("keeps the existing dashboard manager for the Next compatibility runtime", async () => {
    readRustAuthConfig.mockResolvedValue(null);
    const container = await mount();
    expect(container.querySelector('[data-backend="legacy"]')).not.toBeNull();
    expect(container.querySelector('[data-backend="rust"]')).toBeNull();
  });
});
