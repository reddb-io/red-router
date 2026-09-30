/** GET /api/system/backlog: in-flight requests and delivery backlog depth (management auth). */

import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { collectBacklog } from "@/lib/system/backlog";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return NextResponse.json(await collectBacklog(), { headers: { "Cache-Control": "no-store" } });
}
