import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { requestServerRestart } from "@/lib/runtime/serverRestart";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const mode = await requestServerRestart();
    return NextResponse.json({ status: "restarting", mode });
  } catch {
    return errorResponse(
      503,
      "The service manager could not accept the restart. The Router is still running; inspect local diagnostic logs."
    );
  }
}
