// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
import UsersPage from "@/app/(dashboard)/dashboard/users/page";
import TenantAccess from "@/app/(dashboard)/dashboard/tenants/TenantAccess";
import TenantSignIn from "@/app/login/TenantSignIn";

type Call = { url: string; method: string; body?: Record<string, unknown> };
let container: HTMLElement;
let root: Root;
let calls: Call[];
const owner = {
  id: "owner",
  tenantId: "a",
  tenantName: "Acme",
  tenantSlug: "acme",
  email: "owner@acme.test",
  displayName: "Owner",
  role: "admin" as const,
  isOwner: true,
  disabled: false,
  lastLoginAt: null,
};
const user = {
  ...owner,
  id: "user",
  email: "user@acme.test",
  displayName: "User",
  role: "user" as const,
  isOwner: false,
};
const profile = {
  ownerUserId: "owner",
  ownerEmail: "",
  technicalEmail: "",
  billingEmail: "",
  description: "",
  metadata: {},
};
beforeEach(() => {
  calls = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ url, method, body });
    if (url === "/api/access/users") return Response.json({ users: [owner, user] });
    if (url === "/api/tenants")
      return Response.json({ tenants: [{ id: "a", name: "Acme", slug: "acme", disabled: false }] });
    if (url.endsWith("/profile")) return Response.json({ profile: body ?? profile });
    if (url.includes("/api/usage/monthly-report?"))
      return Response.json({
        report: {
          month: "2026-09",
          since: "2026-09-01T00:00:00.000Z",
          until: "2026-10-01T00:00:00.000Z",
          total: {
            requests: 0,
            errors: 0,
            inputTokens: 0,
            outputTokens: 0,
            recordedCostUsd: 0,
            ledgerEntries: 0,
          },
          keys: [],
          coverage: "Retained history only.",
        },
      });
    if (url.endsWith("/invite"))
      return Response.json({
        token: "single-use-private-token",
        expiresAt: "2026-10-07T12:00:00Z",
      });
    if (url === "/api/tenant/me")
      return Response.json({
        user: { email: user.email, role: "user" },
        tenant: { name: "Acme" },
        capabilities: [],
      });
    return Response.json({ success: true });
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const mount = async (element: React.ReactNode) => {
  await act(async () => {
    root.render(element);
  });
};
const button = (label: string, parent: Element = container) =>
  [...parent.querySelectorAll("button")].find((node) => node.textContent?.trim() === label)!;
const click = async (element: Element) => {
  expect(element).toBeTruthy();
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const field = (label: string) => {
  const node = [...container.querySelectorAll("label")].find(
    (node) => node.textContent?.replace("*", "").trim() === label
  )!;
  return document.getElementById(node.htmlFor) as HTMLInputElement;
};
const fill = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

it("lists tenant owners, protects membership actions and creates a usable invitation link", async () => {
  await mount(<UsersPage />);
  const rows = container.querySelectorAll("tbody tr");
  expect(rows.length).toBe(2);
  expect((button("Make user", rows[0]) as HTMLButtonElement).disabled).toBe(true);
  expect((button("Remove", rows[0]) as HTMLButtonElement).disabled).toBe(true);
  await click(button("Invite", rows[1]));
  expect(field("Invitation link").value).toContain("/login#tenant-invite=single-use-private-token");
  expect(
    calls.some((call) => call.url === "/api/tenants/a/users/user/invite" && call.method === "POST")
  ).toBe(true);
  await fill(field("Search users"), "owner@");
  expect(container.querySelectorAll("tbody tr").length).toBe(1);
}, 15000); // CI's first render can include cold component transforms (observed 6.7s).

it("saves tenant contact metadata without fetching credentials and shows empty monthly usage", async () => {
  await mount(<TenantAccess tenantId="a" users={[owner, user]} />);
  expect(container.textContent).toContain("No retained requests for this month.");
  expect(container.textContent).toContain("Not recorded");
  await fill(field("Billing contact email"), "billing@acme.test");
  await click(button("Save profile"));
  expect(calls.find((call) => call.method === "PUT")?.body).toMatchObject({
    ownerUserId: "owner",
    billingEmail: "billing@acme.test",
  });
  expect(container.textContent).toContain("Tenant profile saved.");
  expect(calls.every((call) => !call.url.includes("/keys"))).toBe(true);
});

it("an invitation sets a password then signs in as a tenant without entering the instance dashboard", async () => {
  await mount(<TenantSignIn token="private-invitation" />);
  await fill(field("New password"), "Rivers-and-Mountains-42!");
  await fill(field("Confirm password"), "Rivers-and-Mountains-42!");
  await click(button("Set password"));
  expect(calls.find((call) => call.url.endsWith("accept-invite"))?.body).toEqual({
    token: "private-invitation",
    password: "Rivers-and-Mountains-42!",
  });
  expect(container.textContent).toContain("Password set.");
  await fill(field("Email"), user.email);
  await fill(field("Password"), "Rivers-and-Mountains-42!");
  await click(button("Sign in"));
  expect(container.textContent).toContain("Your account is active.");
  expect(calls.some((call) => call.url === "/api/auth/tenant/login")).toBe(true);
  expect(calls.some((call) => call.url === "/api/auth/login")).toBe(false);
});
