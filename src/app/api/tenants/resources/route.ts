import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { listAllTenantResources } from "@/lib/db/tenants";
import { tenantFailure } from "../_lib";

/** GET /api/tenants/resources — every key, connection and combo with its owning tenant. */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json(listAllTenantResources());
  } catch (error) {
    return tenantFailure(error, "Failed to list resources");
  }
}
