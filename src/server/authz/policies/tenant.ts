import type { AuthOutcome, PolicyContext, RoutePolicy } from "../context";
import { allow, reject } from "../context";
import { matchTenantRoute, roleAtLeast } from "../tenantRoutes";
import { TENANT_SESSION_COOKIE, authenticateTenantToken } from "@/lib/auth/tenantSession";

function readCookie(ctx: PolicyContext, name: string): string | null {
  const viaJar = ctx.request.cookies?.get?.(name)?.value;
  if (viaJar) return viaJar;
  const header = ctx.request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/**
 * TENANT routes: only a valid tenant session, only routes in the manifest, only for a sufficient
 * role. No management credential (dashboard session, management key, CLI token) opens these, so an
 * owner acts on a tenant through the management API, never by impersonation.
 */
export const tenantPolicy: RoutePolicy = {
  routeClass: "TENANT",
  async evaluate(ctx: PolicyContext): Promise<AuthOutcome> {
    const tenant = await authenticateTenantToken(readCookie(ctx, TENANT_SESSION_COOKIE));
    if (!tenant) {
      return reject(401, "TENANT_AUTH_REQUIRED", "Sign in to continue");
    }

    const rule = matchTenantRoute(ctx.request.method, ctx.classification.normalizedPath);
    if (!rule) {
      return reject(403, "TENANT_ROUTE_NOT_ALLOWED", "This endpoint is not available to tenants");
    }
    if (!roleAtLeast(tenant.role, rule.minRole)) {
      return reject(403, "TENANT_ROLE_INSUFFICIENT", "Your role cannot use this endpoint");
    }

    return allow({
      kind: "tenant_session",
      id: tenant.userId,
      label: tenant.tenantId,
      scopes: [tenant.role],
    });
  },
};
