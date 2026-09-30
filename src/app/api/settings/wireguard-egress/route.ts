import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createEgressProfile, listEgressProfiles } from "@/lib/wireguard/egressService";
import { wireGuardEgressCreateSchema } from "@/shared/validation/wireguardEgressSchemas";
import { NO_STORE, auditEgress, egressFailure, parseJsonBody } from "./_lib";

export const dynamic = "force-dynamic";

/** List profiles with live status. No key material: only `hasPrivateKey` / `hasPresharedKey`. */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json({ items: await listEgressProfiles() }, { headers: NO_STORE });
  } catch (error) {
    return egressFailure(error, "Failed to load the WireGuard profiles.", "wireguard-egress GET");
  }
}

/**
 * Create a profile from a pasted wg-quick config. The config is parsed and validated, its secrets
 * are stored encrypted, and the response carries only the summary plus the lines that were ignored
 * (wg-quick hooks are never run). The profile starts disabled.
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const parsed = await parseJsonBody(request, wireGuardEgressCreateSchema);
  if ("response" in parsed) return parsed.response;

  try {
    const result = await createEgressProfile({
      name: parsed.data.name as string,
      config: parsed.data.config,
    });
    auditEgress(request, "wireguard_egress.create", result.profile.id, "success", {
      name: result.profile.name,
      ignoredLines: result.ignored.length,
    });
    return NextResponse.json(
      { profile: result.profile, ignored: result.ignored, warnings: result.warnings },
      { status: 201, headers: NO_STORE }
    );
  } catch (error) {
    auditEgress(request, "wireguard_egress.create", "new", "failure");
    return egressFailure(error, "Failed to create the WireGuard profile.", "wireguard-egress POST");
  }
}
