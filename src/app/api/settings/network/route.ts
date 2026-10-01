import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  applyNetworkAccess,
  NetworkAccessError,
  readNetworkAccessStatus,
} from "@/lib/runtime/networkAccess";
import { AUTHZ_HEADER_PEER_LOCALITY } from "@/server/authz/headers";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const schema = z.object({ mode: z.enum(["local", "lan"]) }).strict();

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;
  try {
    const status = await readNetworkAccessStatus();
    return NextResponse.json(
      {
        ...status,
        canApply: status.managed && request.headers.get(AUTHZ_HEADER_PEER_LOCALITY) === "loopback",
      },
      { headers }
    );
  } catch {
    return errorResponse(500, "Unable to load network access settings.");
  }
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;
  // The central route guard also enforces the real socket peer. Never infer
  // locality from Host or X-Forwarded-For, and never bypass it for manage keys.
  if (request.headers.get(AUTHZ_HEADER_PEER_LOCALITY) !== "loopback")
    return errorResponse(403, "Change network access from this computer's local dashboard.");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "Invalid JSON body.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorResponse(400, "Choose local or local network access.");
  try {
    const status = await applyNetworkAccess(parsed.data.mode);
    return NextResponse.json(status, { status: status.pendingRestart ? 202 : 200, headers });
  } catch (error) {
    if (error instanceof NetworkAccessError) {
      if (error.code === "unsupported")
        return errorResponse(
          409,
          "This install is not running as a managed Linux service. Configure its launcher to change network access."
        );
      if (error.code === "busy")
        return errorResponse(409, "A network change is already being applied.");
      if (error.code === "changed")
        return errorResponse(
          409,
          "Service configuration changed. Reload settings before retrying."
        );
    }
    return errorResponse(
      500,
      "Unable to apply network access settings. The service configuration could not be updated."
    );
  }
}
