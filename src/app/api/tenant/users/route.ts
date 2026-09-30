import { NextResponse } from "next/server";
import { requireTenantAuth } from "@/lib/api/requireTenantAuth";
import { listTenantUsers } from "@/lib/db/tenants";

/** GET /api/tenant/users — the admins and users of MY tenant only. */
export async function GET(request: Request) {
  const auth = await requireTenantAuth(request, { minRole: "admin" });
  if (auth.error) return auth.error;
  return NextResponse.json({ users: listTenantUsers(auth.ctx!.tenantId) });
}
