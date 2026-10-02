const NUMERIC_STRING = /^\d+(\.\d+)?$/;

/**
 * Normalize any stored token-expiry value to epoch milliseconds.
 *
 * `provider_connections.expires_at` / `token_expires_at` are TEXT columns, so a
 * numeric epoch written by an external sync tool reads back as a *string* —
 * and `new Date("1789012345678")` is an Invalid Date. Both numeric shapes are
 * accepted here with the seconds/ms heuristic the Copilot path already used,
 * before falling back to `Date` for ISO 8601 and other date strings.
 *
 * @returns epoch ms, or 0 when the value carries no usable time
 */
export function parseTokenExpiryMs(expiresAt: unknown): number {
  if (typeof expiresAt === "number") {
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return 0;
    return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  }

  if (typeof expiresAt === "string") {
    const trimmed = expiresAt.trim();
    if (!trimmed) return 0;

    if (NUMERIC_STRING.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric) || numeric <= 0) return 0;
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }

    const parsed = new Date(trimmed).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}
