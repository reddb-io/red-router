// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { router, route } = vi.hoisted(() => ({
  router: { push: vi.fn(), refresh: vi.fn() },
  route: { pathname: "/proxy/providers/rankings" },
}));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => route.pathname }));
vi.mock("@/shared/hooks/useElectron", () => ({ useIsElectron: () => false }));
import CommandPalette from "@/shared/components/CommandPalette";
import Header from "@/shared/components/Header";
import Breadcrumbs from "@/shared/components/Breadcrumbs";
import { useNavVisibility } from "@/shared/hooks/useNavVisibility";
import { SIDEBAR_SETTINGS_UPDATED_EVENT } from "@/shared/constants/sidebarVisibility";

let root: Root;
let container: HTMLDivElement;
let settings: Record<string, unknown>;
beforeEach(() => {
  settings = { hiddenSidebarItems: ["setup", "context-caveman"], radarEnabled: false };
  router.push.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("fetch", async () => Response.json(settings));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const mount = async (component: React.ReactNode) => {
  await act(async () => root.render(component));
};
const update = async (detail: Record<string, unknown>) => {
  await act(async () =>
    window.dispatchEvent(new CustomEvent(SIDEBAR_SETTINGS_UPDATED_EVENT, { detail }))
  );
};
const options = () =>
  [...container.querySelectorAll('[role="option"]')].map((item) => item.textContent);

it("palette groups use the rail areas and include hidden pages with canonical detail labels", async () => {
  await mount(<CommandPalette isOpen onClose={() => {}} />);
  expect(options()).toContain("SetupHidden from menu");
  expect(options()).toContain("Token saver › CavemanHidden from menu");
  expect(options().some((label) => label?.includes("Radar"))).toBe(false);
  for (const area of ["Home", "Proxy", "Optimize", "Access", "System"])
    expect(container.querySelector(`[role="group"][aria-label="${area}"]`)).not.toBeNull();
  const target = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Token saver › CavemanHidden from menu"
  )!;
  await act(async () => target.click());
  expect(router.push).toHaveBeenCalledWith("/optimize/token-saver/engines/caveman");
});
it("an open palette follows feature-flag and owner-link changes without reopening", async () => {
  await mount(<CommandPalette isOpen onClose={() => {}} />);
  await update({ radarEnabled: true, radarAdminUrl: "https://private.example/ops" });
  expect(options()).toContain("Providers › Radar");
  expect(options()).toContain("Providers › Radar admin ↗");
  await update({ radarEnabled: false, radarAdminUrl: null });
  expect(options().some((label) => label?.includes("Radar"))).toBe(false);
});
it("header and breadcrumbs use the same page label as the rail and command navigation", async () => {
  await mount(
    <>
      <Header />
      <Breadcrumbs />
    </>
  );
  expect(container.querySelector("header")?.textContent).toContain("Providers › Rankings");
  expect(container.querySelector('[aria-current="page"]')?.textContent).toBe("Rankings");
  expect(container.querySelector('button[aria-label="Open navigation"]')).not.toBeNull();
});
function VisibilityProbe() {
  const state = useNavVisibility();
  return (
    <pre>
      {JSON.stringify({
        hidden: [...state.hidden],
        flags: state.flags,
        radarAdmin: state.radarAdmin,
      })}
    </pre>
  );
}
it("late settings reads preserve newer visibility edits and retain unrelated saved settings", async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    () =>
      new Promise<Response>((accept) => {
        resolve = accept;
      })
  );
  await mount(<VisibilityProbe />);
  await update({ hiddenSidebarItems: [], sidebarActivePreset: null });
  await act(async () =>
    resolve(
      Response.json({
        hiddenSidebarItems: ["setup"],
        radarEnabled: false,
        radarAdminUrl: "https://private.example/ops",
      })
    )
  );
  expect(JSON.parse(container.textContent!)).toEqual({
    hidden: [],
    flags: { RADAR_ENABLED: false },
    radarAdmin: "https://private.example/ops",
  });
  await update({ instanceName: "My router" });
  expect(JSON.parse(container.textContent!).flags.RADAR_ENABLED).toBe(false);
  await update({ hiddenSidebarItems: ["setup"], radarAdminUrl: "javascript:alert(1)" });
  expect(JSON.parse(container.textContent!).radarAdmin).toBeNull();
});
