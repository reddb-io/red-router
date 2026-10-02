/**
 * Persist explicit operator activation intent. An inactive connection remains
 * inactive until the operator enables it; discovery and diagnostics cannot opt in.
 */

export const OPERATOR_DISABLED_AT_KEY = "operatorDisabledAt";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as JsonRecord) }
    : {};
}

/**
 * Returns the providerSpecificData to persist when an operator explicitly sets
 * `isActive` through a management endpoint: turning a connection off stamps the
 * marker, turning it on clears it.
 */
export function applyOperatorActivationIntent(
  providerSpecificData: unknown,
  isActive: boolean,
  now: string = new Date().toISOString()
): JsonRecord {
  const psd = asRecord(providerSpecificData);
  if (isActive) {
    delete psd[OPERATOR_DISABLED_AT_KEY];
  } else {
    psd[OPERATOR_DISABLED_AT_KEY] = now;
  }
  return psd;
}

/**
 * True when the connection is inactive because an operator switched it off.
 * Only an explicit operator `isActive:true` turns it back on.
 */
export function isOperatorDisabled(connection: {
  isActive?: unknown;
  providerSpecificData?: unknown;
}): boolean {
  if (connection.isActive === true) return false;
  const marker = asRecord(connection.providerSpecificData)[OPERATOR_DISABLED_AT_KEY];
  return typeof marker === "string" && marker.length > 0;
}
