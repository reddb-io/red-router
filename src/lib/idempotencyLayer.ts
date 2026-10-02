/**
 * Idempotency Layer — Phase 9.2
 *
 * In-memory deduplication of requests with the same idempotency key.
 * Replays a completed response within the configured deduplication window
 * (5 seconds by default) instead of making a new API call.
 *
 * Headers: X-Request-Id or Idempotency-Key
 *
 * @module lib/idempotencyLayer
 */

import { getSettings } from "@/lib/db/settings";

export const DEFAULT_IDEMPOTENCY_WINDOW_MS = 5000;
const MAX_EXPIRES_AT = 8_640_000_000_000_000;

interface IdempotencyEntry {
  response: unknown;
  status: number;
  expiresAt: number;
}

const idempotencyStore = new Map<string, IdempotencyEntry>();

/** Preserve accepted settings; only bound the timestamp to Date's safe range. */
export function resolveIdempotencyWindowMs(value: unknown, now = Date.now()): number {
  const windowMs =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.ceil(value)
      : DEFAULT_IDEMPOTENCY_WINDOW_MS;
  return Math.max(0, Math.min(windowMs, MAX_EXPIRES_AT - now));
}

function pruneExpiredEntries(now = Date.now()): void {
  for (const [key, entry] of idempotencyStore) {
    if (now >= entry.expiresAt) idempotencyStore.delete(key);
  }
}

// Periodic cleanup every 30s
let cleanupInterval: ReturnType<typeof setInterval> | undefined;

function ensureCleanup() {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(pruneExpiredEntries, 30000);
  // Don't prevent process exit
  if (cleanupInterval.unref) cleanupInterval.unref();
}

/**
 * Extract idempotency key from request headers.
 * @param {Headers|object} headers
 * @returns {string|null}
 */
export function getIdempotencyKey(
  headers: Headers | Record<string, unknown> | null | undefined
): string | null {
  if (!headers) return null;
  const getter = headers.get;
  const get =
    typeof getter === "function"
      ? (key: string): unknown => getter.call(headers, key)
      : (key: string): unknown => headers[key];
  const key = get("idempotency-key") || get("x-request-id");
  return typeof key === "string" && key ? key : null;
}

/**
 * Check if a response exists for the given idempotency key.
 * @param {string} key
 * @returns {{ response: object, status: number }|null}
 */
export function checkIdempotency(key: string | null | undefined) {
  if (!key) return null;
  const entry = idempotencyStore.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    idempotencyStore.delete(key);
    return null;
  }
  return { response: entry.response, status: entry.status };
}

/**
 * Save a response for idempotency dedup.
 * @param {string} key
 * @param {object} response - Response body to cache
 * @param {number} status - HTTP status code
 * @param {unknown} windowMs - Configured dedup window, defaulting to 5000 ms
 */
export function saveIdempotency(
  key: string | null | undefined,
  response: unknown,
  status: number,
  windowMs?: unknown
): void {
  if (!key) return;
  ensureCleanup();
  const now = Date.now();
  idempotencyStore.set(key, {
    response,
    status,
    expiresAt: now + resolveIdempotencyWindowMs(windowMs, now),
  });
}

/**
 * Get current idempotency store stats.
 */
export async function getIdempotencyStats() {
  let configuredWindowMs: unknown;
  try {
    const settings = await getSettings();
    configuredWindowMs = settings.idempotencyWindowMs;
  } catch {
    // Fallback to default if settings unavailable
  }
  const now = Date.now();
  pruneExpiredEntries(now);
  return {
    activeKeys: idempotencyStore.size,
    windowMs: resolveIdempotencyWindowMs(configuredWindowMs, now),
  };
}

/**
 * Clear all idempotency entries (for testing).
 */
export function clearIdempotency() {
  idempotencyStore.clear();
}
