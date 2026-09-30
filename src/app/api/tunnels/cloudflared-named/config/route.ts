import { NextResponse } from "next/server";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  NamedTunnelNotConfiguredError,
  clearCloudflaredNamedTunnel,
  configureCloudflaredNamedTunnel,
  getCloudflaredNamedTunnelStatus,
} from "@/lib/cloudflaredNamedTunnel";
import { cloudflaredNamedTunnelConfigSchema } from "@/shared/validation/namedTunnelSchemas";
import { NO_STORE, auditTunnel, parseJsonBody, tunnelFailure } from "../../_lib/tunnelRoute";

export const dynamic = "force-dynamic";

const TARGET = "cloudflared-named";

/**
 * Save the tunnel token and public hostname. The token is write-only: it is encrypted at rest and
 * no route returns it; the response is the same token-free status object as GET. Omit `token` to
 * change only the hostname.
 */
export async function PUT(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const parsed = await parseJsonBody(request, cloudflaredNamedTunnelConfigSchema);
  if ("response" in parsed) return parsed.response;

  try {
    configureCloudflaredNamedTunnel({
      hostname: parsed.data.hostname as string,
      token: parsed.data.token,
    });
    auditTunnel(request, "tunnel.cloudflared_named.configured", TARGET, "success", {
      hostname: parsed.data.hostname,
      tokenReplaced: Boolean(parsed.data.token),
    });
    return NextResponse.json(
      { success: true, status: await getCloudflaredNamedTunnelStatus() },
      { headers: NO_STORE }
    );
  } catch (error) {
    auditTunnel(request, "tunnel.cloudflared_named.configured", TARGET, "failure");
    if (error instanceof NamedTunnelNotConfiguredError) {
      return errorResponse(400, "token: Enter the tunnel token from Cloudflare");
    }
    return tunnelFailure(
      error,
      "Failed to save the Cloudflare Named Tunnel settings.",
      "tunnels/cloudflared-named/config PUT"
    );
  }
}

/** Stop the tunnel and delete the stored token and hostname. */
export async function DELETE(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const status = await clearCloudflaredNamedTunnel();
    auditTunnel(request, "tunnel.cloudflared_named.cleared", TARGET, "success");
    return NextResponse.json({ success: true, status }, { headers: NO_STORE });
  } catch (error) {
    auditTunnel(request, "tunnel.cloudflared_named.cleared", TARGET, "failure");
    return tunnelFailure(
      error,
      "Failed to remove the Cloudflare Named Tunnel settings.",
      "tunnels/cloudflared-named/config DELETE"
    );
  }
}
