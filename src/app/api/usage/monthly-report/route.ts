import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getMonthlyCostReport } from "@/lib/db/monthlyCostReport";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { tenantFailure } from "../../tenants/_lib";

export const dynamic = "force-dynamic";
const querySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  tenantId: z.string().min(1).max(128).optional(),
  apiKeyIds: z.array(z.string().min(1).max(128)).max(500),
});

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const params = new URL(request.url).searchParams;
  const query = querySchema.safeParse({
    month: params.get("month") ?? new Date().toISOString().slice(0, 7),
    tenantId: params.get("tenantId") ?? undefined,
    apiKeyIds: params.getAll("apiKeyId"),
  });
  if (!query.success) {
    return NextResponse.json(buildErrorBody(400, "Invalid monthly usage query."), { status: 400 });
  }
  try {
    const { month, tenantId, apiKeyIds } = query.data;
    return NextResponse.json({ report: getMonthlyCostReport(month, { tenantId, apiKeyIds }) });
  } catch (error) {
    return tenantFailure(error, "Unable to load monthly usage.");
  }
}
