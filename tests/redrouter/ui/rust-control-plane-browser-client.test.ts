// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readRustAdminCsrfCookie,
  readRustAuthConfig,
  rustAdminFetch,
} from "@/lib/rustControlPlane/browserClient";

afterEach(() => {
  document.cookie = "redrouter_admin_csrf=; Max-Age=0; Path=/";
  vi.unstubAllGlobals();
});

describe("Rust control-plane browser client", () => {
  it("detects the Rust public auth bootstrap without accepting lookalike payloads", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          backend: "rust",
          control_plane_enabled: true,
          oidc_browser_login: true,
          password_login: false,
        })
      )
      .mockResolvedValueOnce(Response.json({ backend: "rust", oidc_browser_login: true }));
    vi.stubGlobal("fetch", fetch);

    await expect(readRustAuthConfig()).resolves.toMatchObject({ oidc_browser_login: true });
    await expect(readRustAuthConfig()).resolves.toBeNull();
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it("copies the double-submit cookie into same-origin Rust admin requests", async () => {
    document.cookie = "unrelated=1; Path=/";
    document.cookie = "redrouter_admin_csrf=fixture-token; Path=/";
    expect(readRustAdminCsrfCookie()).toBe("fixture-token");
    const fetch = vi.fn().mockResolvedValue(Response.json({ providers: [] }));
    vi.stubGlobal("fetch", fetch);

    await rustAdminFetch("/api/admin/providers");
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("x-red-router-csrf")).toBe("fixture-token");
  });

  it("rejects missing sessions and non-admin or cross-origin paths before fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(rustAdminFetch("/api/admin/providers")).rejects.toThrow(
      "Rust admin session is unavailable"
    );
    await expect(rustAdminFetch("https://attacker.example/api/admin/providers")).rejects.toThrow(
      "same-origin"
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
