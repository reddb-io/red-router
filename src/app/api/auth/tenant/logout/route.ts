import { NextResponse } from "next/server";
import { clearTenantSessionCookie } from "@/lib/auth/tenantSessionCookie";

/** POST /api/auth/tenant/logout — drop the tenant session cookie. Public by exact path. */
export async function POST() {
  await clearTenantSessionCookie();
  return NextResponse.json({ success: true });
}
