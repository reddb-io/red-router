import { describe, expect, it } from "vitest";
import { resolveSpaPage, spaPageRoutes } from "../../../rust-dashboard/routes";

describe("Rust SPA route compatibility", () => {
  it("owns a unique canonical route for every Rust dashboard surface", () => {
    expect(spaPageRoutes.map((page) => page.id)).toHaveLength(15);
    expect(new Set(spaPageRoutes.map((page) => page.id)).size).toBe(spaPageRoutes.length);
    expect(new Set(spaPageRoutes.map((page) => page.path)).size).toBe(spaPageRoutes.length);
  });

  it.each([
    ["/", "overview"],
    ["/home", "overview"],
    ["/proxy/endpoint", "endpoints"],
    ["/tools/playground", "playground"],
    ["/observe/health/runtime", "overview"],
    ["/proxy/providers/openrouter-main", "providers"],
    ["/dashboard/resilience/connections", "resilience"],
    ["/proxy/models", "models"],
    ["/proxy/combos/agent-route", "combos"],
    ["/proxy/keys/routing", "keys"],
    ["/observe/costs/quota-share", "budgets"],
    ["/observe/log-export", "usage-sinks"],
    ["/observe/costs", "usage"],
    ["/system/organizations", "organizations"],
    ["/observe/audit/mcp", "audit"],
    ["/system/settings/security", "oidc"],
  ])("resolves %s to the consolidated %s surface", (path, expected) => {
    expect(resolveSpaPage(path)?.id).toBe(expected);
  });

  it("does not pretend unsupported product areas have been ported", () => {
    expect(resolveSpaPage("/optimize/token-saver")).toBeNull();
    expect(resolveSpaPage("/agents/mcp")).toBeNull();
    expect(resolveSpaPage("/api/not-real")).toBeNull();
  });
});
