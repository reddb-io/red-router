/**
 * The manifest of everything a tenant session may call. It is an ALLOW-list: a `/api/tenant/*` route
 * that is not listed here answers 403 whoever calls it, so a new route stays unreachable for tenants
 * until someone adds a row (and reviews the snapshot test that pins this file).
 *
 * Every other class of route (management, client API, public) never accepts the tenant cookie.
 */

export type TenantRouteRole = "user" | "admin";
export type TenantRouteMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface TenantRouteRule {
  readonly method: TenantRouteMethod;
  /** Exact path; `:name` matches one non-empty segment. */
  readonly pattern: string;
  readonly minRole: TenantRouteRole;
  readonly description: string;
}

export const TENANT_ROUTES: readonly TenantRouteRule[] = Object.freeze([
  {
    method: "GET",
    pattern: "/api/tenant/me",
    minRole: "user",
    description: "Who am I, my tenant, and what I may call",
  },
  {
    method: "GET",
    pattern: "/api/tenant/users",
    minRole: "admin",
    description: "Admins and users of my tenant",
  },
  {
    method: "GET",
    pattern: "/api/tenant/keys",
    minRole: "admin",
    description: "API keys of my tenant (masked)",
  },
]);

const ROLE_RANK: Record<TenantRouteRole, number> = { user: 1, admin: 2 };

export function roleAtLeast(role: TenantRouteRole, needed: TenantRouteRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[needed];
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment, index) => index === 0 || segment !== "");
}

function matches(pattern: string, path: string): boolean {
  const want = segmentsOf(pattern);
  const have = segmentsOf(path);
  if (want.length !== have.length) return false;
  return want.every((part, index) =>
    part.startsWith(":") ? have[index] !== "" : part === have[index]
  );
}

/** The rule for this request, or null when the manifest does not allow it. Method-aware. */
export function matchTenantRoute(method: string, pathname: string): TenantRouteRule | null {
  const verb = method.toUpperCase();
  for (const rule of TENANT_ROUTES) {
    if (rule.method === verb && matches(rule.pattern, pathname)) return rule;
  }
  return null;
}

/** The manifest rows a role may call: what `/api/tenant/me` reports as capabilities. */
export function capabilitiesFor(role: TenantRouteRole): TenantRouteRule[] {
  return TENANT_ROUTES.filter((rule) => roleAtLeast(role, rule.minRole));
}
