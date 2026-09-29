import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { WINDOW_SIZES_SEC } from "@/lib/usageSinks/inputSchemas";
import { describeTransports } from "@/lib/usageSinks/transports";

/** GET /api/usage-sinks/types: transport descriptors the dashboard renders its form from. */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return NextResponse.json({ types: describeTransports(), windowSizesSec: WINDOW_SIZES_SEC });
}
