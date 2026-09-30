import { z } from "zod";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { classifyTunnelError } from "@/lib/api/publicSafeTunnelError";
import { redactNamedTunnelText } from "@/lib/cloudflaredNamedTunnel";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance";
import {
  formatValidationMessage,
  isValidationFailure,
  validateBody,
} from "@/shared/validation/helpers";

/**
 * Shared plumbing for the Cloudflare Named Tunnel and Tailscale Serve routes: JSON body parsing
 * with fixed 400s, fixed-message 500s, a redacted server-side log line and best-effort audit.
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
    return { response: errorResponse(400, formatValidationMessage(validation.error)) };
  }
  return { data: validation.data };
}

/**
 * The 500 for a failed tunnel operation. `message` is a literal owned by the route; the caught
 * error is only logged server-side, redacted, and contributes a coarse `reason` label.
 */
export function tunnelFailure(error: unknown, message: string, context: string): Response {
  // Log-only: the redacted text goes to the server console, never into the response body.
  const raw = (error as { message?: unknown } | null)?.message ?? error ?? "";
  console.error(`[${context}]`, redactNamedTunnelText(String(raw)));
  return errorResponse(500, message, { reason: classifyTunnelError(error) });
}

/** Best-effort audit entry; never carries request bodies, tokens or passwords. */
export function auditTunnel(
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
      resourceType: "tunnel",
      status,
      details,
      ipAddress: ipAddress || undefined,
      requestId: requestId || undefined,
    });
  } catch {
    /* audit is best effort */
  }
}
