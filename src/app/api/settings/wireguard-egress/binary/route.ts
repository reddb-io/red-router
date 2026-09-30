import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getWireproxyBinaryStatus } from "@/lib/wireguard/egressBinary";
import { NO_STORE, egressFailure } from "../_lib";

export const dynamic = "force-dynamic";

/** wireproxy detection status. Reports the source (env / managed / PATH), never a filesystem path. */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json(await getWireproxyBinaryStatus(), { headers: NO_STORE });
  } catch (error) {
    return egressFailure(error, "Failed to check for wireproxy.", "wireguard-egress/binary GET");
  }
}
