import { NextResponse } from "next/server";
import { requireTenantAuth } from "@/lib/api/requireTenantAuth";
import { listTenantApiKeys } from "@/lib/db/tenants";

/** GET /api/tenant/keys — the API keys of MY tenant, masked. The key value is never returned. */
export async function GET(request: Request) {
  const auth = await requireTenantAuth(request, { minRole: "admin" });
  if (auth.error) return auth.error;
  return NextResponse.json({ keys: listTenantApiKeys(auth.ctx!.tenantId) });
}
