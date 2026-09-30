import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import {
  ensurePersistentManagementPasswordHash,
  getStoredManagementPassword,
  verifyManagementPassword,
} from "@/lib/auth/managementPassword";
import { getSettings } from "@/lib/db/settings";
import { WireGuardConfigError, type WireGuardConfigErrorCode } from "@/lib/wireguard/serverConfig";

/** Audit target shared by every WireGuard handler. */
export const WIREGUARD_TARGET = "wireguard";

const STATUS_BY_CODE: Record<WireGuardConfigErrorCode, number> = {
  invalid_model: 400,
  invalid_key: 500,
  invalid_peer: 400,
  endpoint_required: 409,
  subnet_exhausted: 409,
  not_configured: 409,
  address_locked: 409,
  peer_not_found: 404,
};

/**
 * The response for a domain error. Only `WireGuardConfigError` qualifies: its messages are fixed
 * literals owned by this feature and never contain key material. Anything else returns null so the
 * caller falls back to the generic fixed-message failure.
 */
export function configErrorResponse(error: unknown): Response | null {
  if (!(error instanceof WireGuardConfigError)) return null;
  return errorResponse(STATUS_BY_CODE[error.code] ?? 400, error.message);
}

/**
 * The current-password gate used for security-impacting changes (same contract as the metrics
 * token route): when a management password exists, `currentPassword` must match it.
 */
export async function passwordGate(currentPassword: string | undefined): Promise<Response | null> {
  const settings = await getSettings();
  const state = await ensurePersistentManagementPasswordHash({
    settings,
    source: "wireguard.rotate",
  });
  const storedHash = getStoredManagementPassword(state.settings);
  if (!storedHash) return null; // no password configured: nothing to verify against
  if (!currentPassword) {
    return errorResponse(400, "currentPassword is required to rotate the WireGuard server key");
  }
  if (!(await verifyManagementPassword(currentPassword, storedHash))) {
    return errorResponse(401, "Invalid current password");
  }
  return null;
}
