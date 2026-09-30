import { NextResponse } from "next/server";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { listAccessUsers } from "@/lib/db/tenantProfiles";
import { tenantFailure } from "../../tenants/_lib";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const tenant = new URL(request.url).searchParams.get("tenant");
  if (tenant !== null && !z.string().min(1).max(128).safeParse(tenant).success) {
    return NextResponse.json(buildErrorBody(400, "Invalid tenant filter"), { status: 400 });
  }
  try {
    return NextResponse.json({ users: listAccessUsers(tenant ?? undefined) });
  } catch (error) {
    return tenantFailure(error, "Failed to load users");
  }
}
