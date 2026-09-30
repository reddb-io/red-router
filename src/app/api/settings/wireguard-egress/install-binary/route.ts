import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getWireproxyBinaryStatus, installWireproxyBinary } from "@/lib/wireguard/egressBinary";
import { NO_STORE, auditEgress, egressFailure } from "../_lib";

export const dynamic = "force-dynamic";

/**
 * Explicit "Install wireproxy". Downloads the pinned release asset over https and installs it only
 * if its SHA-256 matches the checksum pinned in the source. With no pinned checksum for this
 * platform it refuses before any network request.
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    await installWireproxyBinary();
    auditEgress(request, "wireguard_egress.install_binary", "wireproxy", "success");
    return NextResponse.json(
      { success: true, binary: await getWireproxyBinaryStatus() },
      { headers: NO_STORE }
    );
  } catch (error) {
    auditEgress(request, "wireguard_egress.install_binary", "wireproxy", "failure");
    return egressFailure(
      error,
      "Failed to install wireproxy.",
      "wireguard-egress/install-binary POST"
    );
  }
}
