import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { saveWireGuardConfig } from "@/lib/db/wireguardServerConfig";
import { getWireGuardOverview } from "@/lib/wireguard/service";
import { wireguardConfigSchema } from "@/shared/validation/wireguardSchemas";
import { NO_STORE, auditTunnel, parseJsonBody, tunnelFailure } from "../../_lib/tunnelRoute";
import { WIREGUARD_TARGET, configErrorResponse } from "../_lib";

export const dynamic = "force-dynamic";

/**
 * Save the interface name, tunnel address, listen port, endpoint host and DNS. The first save
 * generates the server keypair; later saves never regenerate it (see POST /api/tunnels/wireguard
 * for the explicit, password-gated rotation). The response carries public keys only.
 */
export async function PUT(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const parsed = await parseJsonBody(request, wireguardConfigSchema);
  if ("response" in parsed) return parsed.response;

  try {
    const { config, serverKeyGenerated } = saveWireGuardConfig({
      endpointHost: parsed.data.endpointHost as string,
      interfaceName: parsed.data.interfaceName as string | undefined,
      address: parsed.data.address as string | undefined,
      listenPort: parsed.data.listenPort as number | undefined,
      dns: parsed.data.dns as string | undefined,
    });
    auditTunnel(request, "tunnel.wireguard.configured", WIREGUARD_TARGET, "success", {
      interfaceName: config.interfaceName,
      address: config.address,
      listenPort: config.listenPort,
      endpointHost: config.endpointHost,
      serverKeyGenerated,
    });
    return NextResponse.json(
      { success: true, serverKeyGenerated, ...getWireGuardOverview() },
      { headers: NO_STORE }
    );
  } catch (error) {
    auditTunnel(request, "tunnel.wireguard.configured", WIREGUARD_TARGET, "failure");
    return (
      configErrorResponse(error) ??
      tunnelFailure(error, "Failed to save the WireGuard settings.", "tunnels/wireguard/config PUT")
    );
  }
}
