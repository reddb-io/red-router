import { NextResponse } from "next/server";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  TailscaleServeNotInstalledError,
  disableTailscaleServe,
  enableTailscaleServe,
  getTailscaleServeStatus,
} from "@/lib/tailscaleServe";
import { tailscaleServeActionSchema } from "@/shared/validation/namedTunnelSchemas";
import { NO_STORE, auditTunnel, parseJsonBody, tunnelFailure } from "../_lib/tunnelRoute";

export const dynamic = "force-dynamic";

const TARGET = "tailscale-serve";

/** Tailnet-only (private) endpoint status, read from `tailscale serve status --json`. */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    return NextResponse.json(await getTailscaleServeStatus(), { headers: NO_STORE });
  } catch (error) {
    return tunnelFailure(
      error,
      "Failed to load the Tailscale Serve status.",
      "tunnels/tailscale-serve GET"
    );
  }
}

/** Enable or disable Tailscale Serve for this router. Never stops the Tailscale daemon. */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const parsed = await parseJsonBody(request, tailscaleServeActionSchema);
  if ("response" in parsed) return parsed.response;
  const { action, sudoPassword, hostname } = parsed.data;

  try {
    if (action === "disable") {
      const result = await disableTailscaleServe();
      auditTunnel(request, "tunnel.tailscale_serve.disable", TARGET, "success");
      return NextResponse.json(result, { headers: NO_STORE });
    }

    const result = await enableTailscaleServe({ sudoPassword, hostname });
    auditTunnel(
      request,
      "tunnel.tailscale_serve.enable",
      TARGET,
      result.success ? "success" : "failure"
    );
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    auditTunnel(request, `tunnel.tailscale_serve.${action}`, TARGET, "failure");
    if (error instanceof TailscaleServeNotInstalledError) {
      return errorResponse(409, "Tailscale is not installed on this machine.");
    }
    return tunnelFailure(
      error,
      action === "enable"
        ? "Failed to enable Tailscale Serve."
        : "Failed to disable Tailscale Serve.",
      "tunnels/tailscale-serve POST"
    );
  }
}
