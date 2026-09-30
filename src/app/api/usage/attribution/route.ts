import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { ATTRIBUTION_DIMENSIONS, getAttributionRollup } from "@/lib/db/costAttribution";

const querySchema = z.object({
  by: z.enum(ATTRIBUTION_DIMENSIONS),
  days: z.coerce.number().int().min(1).max(365).default(30),
});

/**
 * GET /api/usage/attribution?by=tag|user&days=30 — metered spend and request count per request
 * tag or end user over the last `days` days (top 100 by spend). Read-only; tags and end users
 * are client-supplied text and are returned verbatim for the caller to escape.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({
    by: searchParams.get("by") ?? undefined,
    days: searchParams.get("days") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          message: "Invalid request",
          details: parsed.error.issues.map((issue) => ({
            field: issue.path.join(".") || "query",
            message: issue.message,
          })),
        },
      },
      { status: 400 }
    );
  }

  try {
    const { by, days } = parsed.data;
    return NextResponse.json({ by, days, rows: getAttributionRollup(by, days) });
  } catch {
    return NextResponse.json({ error: "Failed to load the attribution rollup" }, { status: 500 });
  }
}
