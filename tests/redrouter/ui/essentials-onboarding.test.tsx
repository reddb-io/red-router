// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { push, replace } = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));
vi.mock("@/shared/hooks", () => ({ useDisplayBaseUrl: () => "https://router.example" }));
vi.mock("@/app/(dashboard)/dashboard/onboarding/steps/TierTour", () => ({
  TierTour: () => <p>Tier tour</p>,
}));
import Onboarding from "@/app/(dashboard)/dashboard/onboarding/page";
import FirstRunReadinessCard from "@/app/(dashboard)/dashboard/FirstRunReadinessCard";
import SidebarTab from "@/app/(dashboard)/dashboard/settings/components/SidebarTab";
import { HIDEABLE_SIDEBAR_ITEM_IDS, SIDEBAR_PRESETS } from "@/shared/constants/sidebarVisibility";

let root: Root;
let container: HTMLDivElement;
let calls: { url: string; init?: RequestInit }[];
let securityStatus: number;
let finishStatus: number;
let hasPassword: boolean;
let requireLogin: boolean;
let loginStatus: number;
let readStatus: number;
let initialSettings: Record<string, unknown>;
beforeEach(() => {
  localStorage.clear();
  push.mockReset();
  replace.mockReset();
  calls = [];
  securityStatus = 200;
  finishStatus = 200;
  loginStatus = 200;
  readStatus = 200;
  hasPassword = false;
  requireLogin = true;
  initialSettings = { setupComplete: false };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "/api/settings" && init?.method === "PATCH")
      return Response.json({}, { status: finishStatus });
    if (url === "/api/settings") return Response.json(initialSettings);
    if (url === "/api/settings/require-login" && init?.method === "POST") {
      if (securityStatus === 200) {
        const data = JSON.parse(String(init.body));
        hasPassword = Boolean(data.password);
        requireLogin = data.requireLogin;
      }
      return Response.json({ error: "Security write failed" }, { status: securityStatus });
    }
    if (url === "/api/settings/require-login")
      return Response.json({ hasPassword, requireLogin }, { status: readStatus });
    if (url === "/api/auth/login")
      return Response.json({ error: "Login failed" }, { status: loginStatus });
    throw new Error(`Unexpected endpoint ${url}`);
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const mount = async (component: React.ReactNode) => {
  await act(async () => root.render(component));
};
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)!;
const click = async (label: string) => {
  expect(button(label), label).toBeDefined();
  await act(async () => button(label).click());
};
const change = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const reachSecurity = async () => {
  await mount(<Onboarding />);
  await click("Get Started");
  await click("Continue");
};
const chooseNoPassword = async () => {
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
  );
  await click("Skip & Continue");
};

it("security completion proceeds to the canonical Setup without configuring or testing an arbitrary provider", async () => {
  await reachSecurity();
  expect(button("Skip")).toBeUndefined();
  expect(container.textContent).not.toContain("Skip wizard");
  await chooseNoPassword();
  expect(container.textContent).toContain("https://router.example/v1");
  expect(container.textContent).toContain("No inference request has been sent");
  await click("Open Setup");
  expect(
    calls.filter(
      (call) => call.url === "/api/settings/require-login" && call.init?.method === "POST"
    )
  ).toHaveLength(1);
  expect(calls.find((call) => call.init?.method === "PATCH")?.init?.body).toBe(
    JSON.stringify({ setupComplete: true })
  );
  expect(push).toHaveBeenCalledWith("/home/setup");
  expect(
    calls.some((call) => call.url.startsWith("/api/providers") || call.url.startsWith("/v1/"))
  ).toBe(false);
});
it("a bootstrap 401 stays on Security and retries with the entered token", async () => {
  securityStatus = 401;
  await reachSecurity();
  await chooseNoPassword();
  expect(container.textContent).not.toContain("No inference request has been sent");
  expect(push).not.toHaveBeenCalled();
  const token = container.querySelector<HTMLInputElement>('input[type="text"]')!;
  expect(token).not.toBeNull();
  await change(token, "operator-one-shot-token");
  securityStatus = 200;
  await click("Retry");
  const writes = calls.filter((call) => call.init?.method === "POST");
  expect(writes.at(-1)?.init?.headers).toMatchObject({
    "x-omniroute-bootstrap-token": "operator-one-shot-token",
  });
  expect(container.textContent).toContain("No inference request has been sent");
});
it("password setup requires successful login and never writes completion after login failure", async () => {
  loginStatus = 401;
  await reachSecurity();
  for (const input of container.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    await change(input, "fixture-password");
  await click("Set Password");
  expect(container.textContent).toContain("Login failed");
  expect(container.textContent).not.toContain("No inference request has been sent");
  expect(calls.some((call) => call.init?.method === "PATCH")).toBe(false);
  expect(push).not.toHaveBeenCalled();
});
it.each([401, 500])(
  "a rejected completion write (%i) does not navigate to Setup",
  async (status) => {
    await reachSecurity();
    await chooseNoPassword();
    finishStatus = status;
    await click("Open Setup");
    expect(push).not.toHaveBeenCalled();
    expect(container.textContent).toContain(status === 401 ? "token" : "Connection error");
  }
);
it("a failed security read never disables login or marks bootstrap complete", async () => {
  await reachSecurity();
  await chooseNoPassword();
  readStatus = 500;
  await click("Open Setup");
  expect(
    calls.filter(
      (call) => call.url === "/api/settings/require-login" && call.init?.method === "POST"
    )
  ).toHaveLength(1);
  expect(calls.some((call) => call.init?.method === "PATCH")).toBe(false);
  expect(push).not.toHaveBeenCalled();
});
it("already completed bootstrap opens maintenance Setup", async () => {
  initialSettings = { setupComplete: true };
  await mount(<Onboarding />);
  expect(replace).toHaveBeenCalledWith("/home/setup");
});
it("first-request guidance remains available after bootstrap but disappears for retained or unknown activity", async () => {
  expect(renderToString(<FirstRunReadinessCard setupComplete hasActivity={false} />)).toBe("");
  await mount(<FirstRunReadinessCard setupComplete hasActivity={false} />);
  expect(container.querySelector('a[href="/home/setup"]')).not.toBeNull();
  await mount(<FirstRunReadinessCard setupComplete={false} hasActivity={false} />);
  expect(container.querySelector('a[href="/dashboard/onboarding"]')).not.toBeNull();
  await mount(<FirstRunReadinessCard setupComplete={false} hasActivity />);
  expect(container.textContent).toBe("");
  await mount(<FirstRunReadinessCard setupComplete={false} hasActivity={null} />);
  expect(container.textContent).toBe("");
});
it("dismissal hides the guidance for this session even when writing browser storage fails", async () => {
  await mount(<FirstRunReadinessCard setupComplete hasActivity={false} />);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage blocked");
  });
  await click("Dismiss for now");
  expect(container.textContent).toBe("");
});
it("sidebar settings reflect the upgraded Essentials and keep saved visibility after a rejected write", async () => {
  const shown = new Set([
    "home",
    "endpoints",
    "api-manager",
    "providers",
    "health",
    "settings-general",
    "settings-sidebar",
  ]);
  initialSettings = {
    sidebarActivePreset: "essentials",
    hiddenSidebarItems: HIDEABLE_SIDEBAR_ITEM_IDS.filter((id) => !shown.has(id)),
  };
  await mount(<SidebarTab />);
  const setup = container.querySelector<HTMLButtonElement>('[aria-label="Show: Setup"]')!;
  expect(setup.getAttribute("aria-checked")).toBe("true");
  finishStatus = 500;
  await act(async () => setup.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
  expect(setup.getAttribute("aria-checked")).toBe("true");
  expect(
    [...container.querySelectorAll("button")]
      .find((item) => item.textContent?.includes("Essentials"))
      ?.getAttribute("aria-pressed")
  ).toBe("true");
  finishStatus = 200;
  await act(async () => setup.click());
  expect(setup.getAttribute("aria-checked")).toBe("false");
  const writes = calls.filter((call) => call.init?.method === "PATCH");
  const saved = JSON.parse(String(writes.at(-1)?.init?.body));
  expect(saved.sidebarActivePreset).toBeNull();
  expect(new Set(saved.hiddenSidebarItems)).toEqual(
    new Set([...SIDEBAR_PRESETS.find((preset) => preset.id === "essentials")!.hiddenItems, "setup"])
  );
});
