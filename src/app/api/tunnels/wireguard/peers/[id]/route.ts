import { NextResponse } from "next/server";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { removeWireGuardPeer } from "@/lib/db/wireguardServerConfig";
import { getWireGuardOverview } from "@/lib/wireguard/service";
import { isValidPeerId } from "@/shared/validation/wireguardSchemas";
import { NO_STORE, auditTunnel, tunnelFailure } from "../../../_lib/tunnelRoute";
import { WIREGUARD_TARGET } from "../../_lib";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

/** Remove a peer and its stored preshared key. Regenerate nothing; other peers are untouched. */
export async function DELETE(request: Request, { params }: RouteParams) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { id } = await params;
  if (!isValidPeerId(id)) return errorResponse(400, "Invalid peer id");

  try {
    const removed = removeWireGuardPeer(id);
    auditTunnel(
      request,
      "tunnel.wireguard.peer_removed",
      WIREGUARD_TARGET,
      removed ? "success" : "failure",
      { peerId: id }
    );
    if (!removed) return errorResponse(404, "WireGuard peer not found");
    return NextResponse.json(
      {
        success: true,
        notice:
          "The peer was removed from RedRouter's settings. Download the server config and reload the interface on the host for it to stop being accepted.",
        ...getWireGuardOverview(),
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    auditTunnel(request, "tunnel.wireguard.peer_removed", WIREGUARD_TARGET, "failure", {
      peerId: id,
    });
    return tunnelFailure(
      error,
      "Failed to remove the WireGuard peer.",
      "tunnels/wireguard/peers DELETE"
    );
  }
}
