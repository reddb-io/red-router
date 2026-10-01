import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTenantAuth } from "@/lib/api/requireTenantAuth";
import { getTenantMonthlyUsage } from "@/lib/db/tenantUsage";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** Authenticated tenant ownership is the only scope; query parameters cannot select a tenant. */
export async function GET(request: Request) {
  const auth = await requireTenantAuth(request, { minRole: "admin" });
  if (auth.error) return auth.error;
  const month =
    new URL(request.url).searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
  if (!monthSchema.safeParse(month).success)
    return NextResponse.json(buildErrorBody(400, "Use a month in YYYY-MM format."), {
      status: 400,
    });
  try {
    return NextResponse.json({ usage: getTenantMonthlyUsage(auth.ctx!.tenantId, month) });
  } catch {
    return NextResponse.json(buildErrorBody(500, "Unable to load tenant usage."), { status: 500 });
  }
}
