import { NextResponse } from "next/server";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  NamedTunnelNotConfiguredError,
  getCloudflaredNamedTunnelStatus,
  restartCloudflaredNamedTunnel,
  startCloudflaredNamedTunnel,
  stopCloudflaredNamedTunnel,
} from "@/lib/cloudflaredNamedTunnel";
import { cloudflaredNamedTunnelActionSchema } from "@/shared/validation/namedTunnelSchemas";
import { NO_STORE, auditTunnel, parseJsonBody, tunnelFailure } from "../_lib/tunnelRoute";

export const dynamic = "force-dynamic";

const TARGET = "cloudflared-named";

/** Status. Never contains the tunnel token (only `hasToken`). */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    return NextResponse.json(await getCloudflaredNamedTunnelStatus(), { headers: NO_STORE });
  } catch (error) {
    return tunnelFailure(
      error,
      "Failed to load the Cloudflare Named Tunnel status.",
      "tunnels/cloudflared-named GET"
    );
  }
}

/** Enable, disable or restart the tunnel with the stored token and hostname. */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const parsed = await parseJsonBody(request, cloudflaredNamedTunnelActionSchema);
  if ("response" in parsed) return parsed.response;
  const { action } = parsed.data;

  try {
    const status =
      action === "enable"
        ? await startCloudflaredNamedTunnel()
        : action === "restart"
          ? await restartCloudflaredNamedTunnel()
          : await stopCloudflaredNamedTunnel();
    auditTunnel(request, `tunnel.cloudflared_named.${action}`, TARGET, "success", {
      hostname: status.hostname,
    });
    return NextResponse.json({ success: true, action, status }, { headers: NO_STORE });
  } catch (error) {
    auditTunnel(request, `tunnel.cloudflared_named.${action}`, TARGET, "failure");
    if (error instanceof NamedTunnelNotConfiguredError) {
      return errorResponse(
        409,
        "Save the tunnel token and hostname before enabling the Cloudflare Named Tunnel."
      );
    }
    return tunnelFailure(
      error,
      "Failed to update the Cloudflare Named Tunnel.",
      "tunnels/cloudflared-named POST"
    );
  }
}
