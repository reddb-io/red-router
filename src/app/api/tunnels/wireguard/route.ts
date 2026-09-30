import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { rotateWireGuardServerKey } from "@/lib/db/wireguardServerConfig";
import { getWireGuardOverview } from "@/lib/wireguard/service";
import { wireguardActionSchema } from "@/shared/validation/wireguardSchemas";
import { NO_STORE, auditTunnel, parseJsonBody, tunnelFailure } from "../_lib/tunnelRoute";
import { WIREGUARD_TARGET, configErrorResponse, passwordGate } from "./_lib";

export const dynamic = "force-dynamic";

/**
 * WireGuard ingress: the saved settings (public keys only) and the live status. No secret is ever
 * part of this response: the server private key and preshared keys are not readable through it.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    return NextResponse.json(getWireGuardOverview(), { headers: NO_STORE });
  } catch (error) {
    return tunnelFailure(error, "Failed to load the WireGuard status.", "tunnels/wireguard GET");
  }
}

/**
 * Rotate the server keypair. Explicit and password-gated because it invalidates every issued peer
 * file (they still name the old server public key). Saving settings never does this implicitly.
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const parsed = await parseJsonBody(request, wireguardActionSchema);
  if ("response" in parsed) return parsed.response;

  const gate = await passwordGate(parsed.data.currentPassword);
  if (gate) {
    auditTunnel(request, "tunnel.wireguard.server_key_rotated", WIREGUARD_TARGET, "failure", {
      reason: "password_check_failed",
    });
    return gate;
  }

  try {
    const config = rotateWireGuardServerKey();
    auditTunnel(request, "tunnel.wireguard.server_key_rotated", WIREGUARD_TARGET, "success", {
      interfaceName: config.interfaceName,
      peerCount: config.peers.length,
    });
    return NextResponse.json(
      {
        success: true,
        serverPublicKey: config.serverPublicKey,
        notice:
          "The server key was replaced. Download the server config again and bring the interface up with it. Every peer file still names the old server public key, so replace the server PublicKey in each peer, or delete and re-add the peers.",
        ...getWireGuardOverview(),
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    auditTunnel(request, "tunnel.wireguard.server_key_rotated", WIREGUARD_TARGET, "failure");
    return (
      configErrorResponse(error) ??
      tunnelFailure(error, "Failed to rotate the WireGuard server key.", "tunnels/wireguard POST")
    );
  }
}
