import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  ensurePersistentManagementPasswordHash,
  getStoredManagementPassword,
  verifyManagementPassword,
} from "@/lib/auth/managementPassword";
import { getSettings } from "@/lib/db/settings";
import {
  clearPrometheusMetricsToken,
  generatePrometheusMetricsToken,
  hasPrometheusMetricsToken,
} from "@/lib/db/metricsToken";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance";

export const dynamic = "force-dynamic";

/**
 * Scrape-token management for GET /api/metrics. Management auth only (this route is NOT in the
 * public route list). Minting and revoking take the current password when one is configured, like
 * every other change that widens who can read the router's data. The plaintext token is returned
 * once by POST and is never readable again.
 */

const gateSchema = z.object({ currentPassword: z.string().max(200).optional() }).passthrough();

const NO_STORE = { "Cache-Control": "no-store" };

async function passwordGate(request: Request): Promise<Response | null> {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const parsed = gateSchema.safeParse(body);
  const currentPassword = parsed.success ? parsed.data.currentPassword : undefined;

  const settings = await getSettings();
  const state = await ensurePersistentManagementPasswordHash({
    settings,
    source: "metrics.token",
  });
  const storedHash = getStoredManagementPassword(state.settings);
  if (!storedHash) return null; // no password configured: nothing to verify against

  if (!currentPassword) {
    return errorResponse(400, "currentPassword is required to change the metrics token");
  }
  if (!(await verifyManagementPassword(currentPassword, storedHash))) {
    return errorResponse(401, "Invalid current password");
  }
  return null;
}

function audit(request: Request, action: string) {
  try {
    const { ipAddress, requestId } = getAuditRequestContext(request);
    logAuditEvent({
      action,
      actor: "dashboard",
      target: "metrics",
      resourceType: "metrics_token",
      status: "success",
      ipAddress: ipAddress || undefined,
      requestId: requestId || undefined,
    });
  } catch {
    /* audit is best effort */
  }
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json({ hasToken: hasPrometheusMetricsToken() }, { headers: NO_STORE });
  } catch {
    return errorResponse(500, "Could not read the metrics token state");
  }
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const gateError = await passwordGate(request);
  if (gateError) return gateError;
  try {
    const token = generatePrometheusMetricsToken();
    audit(request, "metrics.token_generated");
    return NextResponse.json({ token, hasToken: true }, { headers: NO_STORE });
  } catch {
    return errorResponse(500, "Could not generate the metrics token");
  }
}

export async function DELETE(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const gateError = await passwordGate(request);
  if (gateError) return gateError;
  try {
    clearPrometheusMetricsToken();
    audit(request, "metrics.token_revoked");
    return NextResponse.json({ hasToken: false }, { headers: NO_STORE });
  } catch {
    return errorResponse(500, "Could not revoke the metrics token");
  }
}
