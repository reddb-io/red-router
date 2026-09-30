import { NextResponse } from "next/server";
import {
  TENANT_SESSION_COOKIE,
  authenticateTenantToken,
  type TenantContext,
} from "@/lib/auth/tenantSession";
import { roleAtLeast, type TenantRouteRole } from "@/server/authz/tenantRoutes";

export interface TenantAuthResult {
  /** Set when the caller is a valid tenant session with a sufficient role. */
  ctx: TenantContext | null;
  /** Set (and `ctx` null) when the request must be refused. */
  error: Response | null;
}

function cookieFrom(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index !== -1 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/**
 * Handler-side guard for every `/api/tenant/*` route. It does not trust the pipeline's stamp: it
 * re-verifies the tenant cookie and reloads the user, tenant and role from the database, so a route
 * stays safe even if it were ever reached without the pipeline. Management credentials never pass.
 */
export async function requireTenantAuth(
  request: Request,
  options: { minRole: TenantRouteRole }
): Promise<TenantAuthResult> {
  const ctx = await authenticateTenantToken(cookieFrom(request, TENANT_SESSION_COOKIE));
  if (!ctx) {
    return {
      ctx: null,
      error: NextResponse.json(
        { error: { code: "TENANT_AUTH_REQUIRED", message: "Sign in to continue" } },
        { status: 401 }
      ),
    };
  }
  if (!roleAtLeast(ctx.role, options.minRole)) {
    return {
      ctx: null,
      error: NextResponse.json(
        {
          error: {
            code: "TENANT_ROLE_INSUFFICIENT",
            message: "Your role cannot use this endpoint",
          },
        },
        { status: 403 }
      ),
    };
  }
  return { ctx, error: null };
}
