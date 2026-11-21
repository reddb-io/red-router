// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/shared/components/Icon", () => ({ default: () => null }));
vi.mock("@/shared/components", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Input: ({
    label,
    value,
    onChange,
    disabled,
  }: {
    label: string;
    value: string;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
    disabled?: boolean;
  }) => (
    <label>
      {label}
      <input aria-label={label} value={value} onChange={onChange} disabled={disabled} />
    </label>
  ),
  Toggle: ({ checked }: { checked: boolean }) => <span data-toggle={String(checked)} />,
}));

import OidcSection from "@/app/(dashboard)/dashboard/settings/components/OidcSection";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  document.cookie = "redrouter_admin_csrf=fixture-csrf; Path=/";
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.cookie = "redrouter_admin_csrf=; Max-Age=0; Path=/";
  vi.unstubAllGlobals();
});

it("loads, discovers and saves the Rust-owned OIDC contract with browser CSRF", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push({ path, init });
    if (path === "/api/auth/config") {
      return Response.json({
        backend: "rust",
        control_plane_enabled: true,
        oidc_browser_login: true,
        password_login: false,
      });
    }
    if (path === "/api/admin/oidc" && init?.method === "PUT") {
      return Response.json({ oidc: { browser: { has_client_secret: true } } });
    }
    if (path === "/api/admin/oidc") {
      return Response.json({
        oidc: {
          enabled: true,
          issuer: "https://issuer.example",
          audience: "red-router-admin",
          jwks_uri: "https://issuer.example/jwks",
          required_claims: { role: ["owner"] },
          allowed_subjects: ["owner@example.com"],
          browser: {
            public_origin: "https://router.example",
            client_id: "red-router-dashboard",
            authorization_endpoint: "https://issuer.example/authorize",
            token_endpoint: "https://issuer.example/token",
            scopes: ["openid", "profile", "email"],
            has_client_secret: true,
          },
        },
      });
    }
    if (path === "/api/admin/oidc/discover") {
      return Response.json({
        discovery: {
          issuer: "https://issuer.example",
          authorization_endpoint: "https://issuer.example/oauth/authorize",
          token_endpoint: "https://issuer.example/oauth/token",
          jwks_uri: "https://issuer.example/oauth/jwks",
          scopes_supported: ["openid", "profile", "email"],
        },
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetch);

  await act(async () => root.render(<OidcSection />));
  await vi.waitFor(() => {
    expect(container.querySelector<HTMLInputElement>('[aria-label="Client ID"]')?.value).toBe(
      "red-router-dashboard"
    );
  });
  expect(container.textContent).toContain("Rust owns discovery");
  expect(container.textContent).not.toContain("Turn password login off");

  const discover = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Discover endpoints"
  );
  await act(async () => discover?.click());
  await vi.waitFor(() => {
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Token endpoint"]')?.value
    ).toBe("https://issuer.example/oauth/token");
  });

  const save = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save"
  );
  await act(async () => save?.click());
  await vi.waitFor(() => expect(container.textContent).toContain("Saved in Rust"));

  const adminRequests = requests.filter((request) => request.path.startsWith("/api/admin/"));
  expect(adminRequests).toHaveLength(3);
  for (const request of adminRequests) {
    expect(new Headers(request.init?.headers).get("x-red-router-csrf")).toBe("fixture-csrf");
  }
  const saved = JSON.parse(String(adminRequests[2]?.init?.body));
  expect(saved).toMatchObject({
    issuer: "https://issuer.example",
    jwks_uri: "https://issuer.example/oauth/jwks",
    browser: {
      client_id: "red-router-dashboard",
      token_endpoint: "https://issuer.example/oauth/token",
    },
  });
  expect(saved.browser).not.toHaveProperty("client_secret");
});
