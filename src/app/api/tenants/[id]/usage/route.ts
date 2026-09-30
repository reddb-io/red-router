import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getTenantMonthlyUsage } from "@/lib/db/tenantUsage";
import { tenantFailure } from "../../_lib";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    const { id } = await context.params;
    const month =
      new URL(request.url).searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
    return NextResponse.json({ usage: getTenantMonthlyUsage(id, month) });
  } catch (error) {
    return tenantFailure(error, "Failed to load tenant usage");
  }
}
