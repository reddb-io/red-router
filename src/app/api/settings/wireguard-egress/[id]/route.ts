import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  deleteEgressProfile,
  disableEgressProfile,
  enableEgressProfile,
  getEgressProfile,
  restartEgressProfile,
} from "@/lib/wireguard/egressService";
import { wireGuardEgressActionSchema } from "@/shared/validation/wireguardEgressSchemas";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { NO_STORE, auditEgress, egressFailure, parseJsonBody } from "../_lib";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function validId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

export async function GET(request: Request, { params }: Context) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await params;
  if (!validId(id)) return errorResponse(404, "WireGuard profile not found.");
  try {
    const profile = await getEgressProfile(id);
    if (!profile) return errorResponse(404, "WireGuard profile not found.");
    return NextResponse.json({ profile }, { headers: NO_STORE });
  } catch (error) {
    return egressFailure(
      error,
      "Failed to load the WireGuard profile.",
      "wireguard-egress/[id] GET"
    );
  }
}

/** Enable, disable or restart one tunnel. */
export async function PATCH(request: Request, { params }: Context) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await params;
  if (!validId(id)) return errorResponse(404, "WireGuard profile not found.");

  const parsed = await parseJsonBody(request, wireGuardEgressActionSchema);
  if ("response" in parsed) return parsed.response;
  const { action } = parsed.data;

  try {
    const profile =
      action === "enable"
        ? await enableEgressProfile(id)
        : action === "restart"
          ? await restartEgressProfile(id)
          : await disableEgressProfile(id);
    auditEgress(request, `wireguard_egress.${action}`, id, "success", { name: profile.name });
    if (action !== "disable" && profile.status.phase !== "running") {
      // The tunnel did not come up. The profile stays as the operator left it (its proxy is
      // inactive, so assignments fail closed); the reason is in the profile status.
      return errorResponse(
        502,
        "The WireGuard tunnel did not start. Check the profile status for details.",
        { reason: "tunnel_not_running" }
      );
    }
    return NextResponse.json({ success: true, action, profile }, { headers: NO_STORE });
  } catch (error) {
    auditEgress(request, `wireguard_egress.${action}`, id, "failure");
    return egressFailure(
      error,
      "Failed to update the WireGuard tunnel.",
      "wireguard-egress/[id] PATCH"
    );
  }
}

/** Delete a profile. `?force=1` also drops proxy assignments (traffic then leaves directly). */
export async function DELETE(request: Request, { params }: Context) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await params;
  if (!validId(id)) return errorResponse(404, "WireGuard profile not found.");
  const force = new URL(request.url).searchParams.get("force") === "1";

  try {
    await deleteEgressProfile(id, { force });
    auditEgress(request, "wireguard_egress.delete", id, "success", { force });
    return NextResponse.json({ success: true }, { headers: NO_STORE });
  } catch (error) {
    auditEgress(request, "wireguard_egress.delete", id, "failure", { force });
    return egressFailure(
      error,
      "Failed to delete the WireGuard profile.",
      "wireguard-egress/[id] DELETE"
    );
  }
}
