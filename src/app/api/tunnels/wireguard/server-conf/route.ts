import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { buildServerConfDownload } from "@/lib/wireguard/service";
import { auditTunnel, tunnelFailure } from "../../_lib/tunnelRoute";
import { WIREGUARD_TARGET } from "../_lib";

export const dynamic = "force-dynamic";

/**
 * Download the server's wg-quick file. It CONTAINS THE SERVER PRIVATE KEY (and the peers'
 * preshared keys), so it needs management auth, is loopback-only like the rest of the prefix, is
 * never cached and every download is audited.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const download = buildServerConfDownload();
    if (!download) {
      auditTunnel(request, "tunnel.wireguard.server_conf_downloaded", WIREGUARD_TARGET, "failure");
      return errorResponse(409, "WireGuard is not configured yet.");
    }
    auditTunnel(request, "tunnel.wireguard.server_conf_downloaded", WIREGUARD_TARGET, "success", {
      filename: download.filename,
    });
    return new Response(download.body, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${download.filename}"`,
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    auditTunnel(request, "tunnel.wireguard.server_conf_downloaded", WIREGUARD_TARGET, "failure");
    return tunnelFailure(
      error,
      "Failed to build the WireGuard server config.",
      "tunnels/wireguard/server-conf GET"
    );
  }
}
