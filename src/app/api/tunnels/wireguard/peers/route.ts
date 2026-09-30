import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createPeerConfig } from "@/lib/wireguard/service";
import { wireguardPeerAddSchema } from "@/shared/validation/wireguardSchemas";
import { NO_STORE, auditTunnel, parseJsonBody, tunnelFailure } from "../../_lib/tunnelRoute";
import { WIREGUARD_TARGET, configErrorResponse } from "../_lib";

export const dynamic = "force-dynamic";

/**
 * Add a peer. The peer's private key is generated here, returned ONCE inside `config` (the
 * complete wg-quick file) and never stored: only its public key is kept. Losing the file means
 * deleting the peer and adding it again. QR codes are not produced (no QR library is bundled);
 * import the file, or paste it into the WireGuard app.
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const parsed = await parseJsonBody(request, wireguardPeerAddSchema);
  if ("response" in parsed) return parsed.response;

  try {
    const created = createPeerConfig({
      name: parsed.data.name as string,
      usePresharedKey: parsed.data.usePresharedKey !== false,
    });
    auditTunnel(request, "tunnel.wireguard.peer_added", WIREGUARD_TARGET, "success", {
      peerId: created.peer.id,
      name: created.peer.name,
      allowedIp: created.peer.allowedIp,
      presharedKey: created.peer.hasPresharedKey,
    });
    return NextResponse.json({ success: true, ...created }, { headers: NO_STORE });
  } catch (error) {
    auditTunnel(request, "tunnel.wireguard.peer_added", WIREGUARD_TARGET, "failure");
    return (
      configErrorResponse(error) ??
      tunnelFailure(error, "Failed to add the WireGuard peer.", "tunnels/wireguard/peers POST")
    );
  }
}
