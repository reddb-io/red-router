import { z } from "zod";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance";
import { redactEgressText } from "@/lib/wireguard/egressProcess";
import { EgressServiceError } from "@/lib/wireguard/egressService";
import { WireproxyInstallError } from "@/lib/wireguard/egressBinary";
import {
  formatValidationMessage,
  isValidationFailure,
  validateBody,
} from "@/shared/validation/helpers";

/**
 * Shared plumbing for the WireGuard egress routes: JSON bodies with fixed 400s, public-safe
 * errors, and a best-effort audit entry. Nothing here ever handles key material: the config text
 * is parsed inside the service and only fixed sentences come back.
 */

export const NO_STORE = { "Cache-Control": "no-store" };

export async function parseJsonBody<TSchema extends z.ZodTypeAny>(
  request: Request,
  schema: TSchema
): Promise<{ data: z.infer<TSchema> } | { response: Response }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { response: errorResponse(400, "Invalid JSON body") };
  }
  const validation = validateBody(schema, raw);
  if (isValidationFailure(validation)) {
    // Field-level messages come from our own schema literals, never from the submitted values.
    return { response: errorResponse(400, formatValidationMessage(validation.error)) };
  }
  return { data: validation.data };
}

/** Known domain errors map to fixed messages; anything else is a fixed 500 and a redacted log line. */
export function egressFailure(error: unknown, message: string, context: string): Response {
  if (error instanceof EgressServiceError) {
    switch (error.code) {
      case "not_found":
        return errorResponse(404, "WireGuard profile not found.");
      case "config_invalid":
        return errorResponse(
          400,
          `Invalid WireGuard configuration. ${error.details.slice(0, 5).join(" ")}`.trim()
        );
      case "duplicate_name":
        return errorResponse(409, "A WireGuard profile with this name already exists.");
      case "limit_reached":
        return errorResponse(409, "The maximum number of WireGuard profiles has been reached.");
      case "invalid_name":
        return errorResponse(
          400,
          "Profile name must be 1-64 characters without control characters."
        );
      case "in_use":
        return errorResponse(
          409,
          "This tunnel's proxy is still assigned to connections, providers or combos. Unassign it first, otherwise that traffic would leave without the VPN."
        );
    }
  }
  if (error instanceof WireproxyInstallError) {
    // The message is one of a fixed set owned by the install helper.
    const status =
      error.code === "checksum_mismatch" || error.code === "download_failed" ? 502 : 422;
    return errorResponse(status, error.message, { reason: error.code });
  }
  const raw = (error as { message?: unknown } | null)?.message ?? error ?? "";
  console.error(`[${context}]`, redactEgressText(String(raw)));
  return errorResponse(500, message);
}

/** Best-effort audit entry; never carries the config, keys, credentials or paths. */
export function auditEgress(
  request: Request,
  action: string,
  target: string,
  status: "success" | "failure",
  details?: Record<string, unknown>
): void {
  try {
    const { ipAddress, requestId } = getAuditRequestContext(request);
    logAuditEvent({
      action,
      actor: "dashboard",
      target,
      resourceType: "wireguard_egress",
      status,
      details,
      ipAddress: ipAddress || undefined,
      requestId: requestId || undefined,
    });
  } catch {
    /* audit is best effort */
  }
}
