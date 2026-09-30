import { NextResponse } from "next/server";
import { requireTenantAuth } from "@/lib/api/requireTenantAuth";
import { getTenant } from "@/lib/db/tenants";
import { capabilitiesFor } from "@/server/authz/tenantRoutes";

/** GET /api/tenant/me — who I am, my tenant, and exactly what my role may call. */
export async function GET(request: Request) {
  const auth = await requireTenantAuth(request, { minRole: "user" });
  if (auth.error) return auth.error;
  const ctx = auth.ctx!;
  const tenant = getTenant(ctx.tenantId);
  return NextResponse.json({
    user: { id: ctx.userId, email: ctx.email, role: ctx.role },
    tenant: { id: ctx.tenantId, slug: ctx.tenantSlug, name: tenant?.name ?? ctx.tenantSlug },
    capabilities: capabilitiesFor(ctx.role).map((rule) => ({
      method: rule.method,
      path: rule.pattern,
      description: rule.description,
    })),
  });
}
