/**
 * Login brute-force guard.
 *
 * Tracks failed `/api/auth/login` attempts per client IP in process memory
 * and returns lockout decisions. Single-process scope is intentional — this
 * is a defense-in-depth check that pairs with Cloudflare/reverse-proxy rate
 * limiting, not a substitute for it.
 *
 * The failure COUNTERS live in memory; the lockout DECISION is persisted (db/loginLockouts.ts) so a
 * restart does not hand an attacker a fresh budget. Repeated lockouts of the same client escalate:
 * 15 min, 30 min, 1 h, 6 h, then 24 h, and the level decays after a day without a new lockout.
 *
 * Tunables:
 *   - failure threshold: 5 within `WINDOW_MS`
 *   - lockout duration: `LOCKOUT_MS` first, then `LOCKOUT_STEPS_MS`
 *   - sliding window: `WINDOW_MS`
 *
 * The guard is a no-op when `enabled` is false; the caller decides based on
 * the `bruteForceProtection` setting (default true).
 */

import {
  clearAllLockouts,
  deleteLockout,
  pruneLockouts,
  readLockout,
  writeLockout,
} from "@/lib/db/loginLockouts";

const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const FAILURE_THRESHOLD = 5;
/** Lockout length by level (1-based): the first is the historic 15 minutes. */
const LOCKOUT_STEPS_MS = [
  LOCKOUT_MS,
  30 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];
/** A client that stays clean this long after a lockout ends starts again at level 1. */
const LEVEL_DECAY_MS = 24 * 60 * 60 * 1000;

interface AttemptState {
  count: number;
  firstAttemptAt: number;
  lockedUntil: number | null;
  /** How many lockouts in a row this client has earned. */
  level: number;
}

/** Keys whose persisted decision has already been read into memory in this process. */
const hydrated = new Set<string>();

function lockoutDurationMs(level: number): number {
  return LOCKOUT_STEPS_MS[Math.min(Math.max(level, 1), LOCKOUT_STEPS_MS.length) - 1];
}

/**
 * The persisted decision for a key that memory has not seen (after a restart), loaded once. A lock
 * still running is restored as such; one that ended long ago has decayed and is dropped.
 */
function hydrate(key: string, now: number): void {
  if (hydrated.has(key) || attempts.has(key)) return;
  hydrated.add(key);
  const saved = readLockout(key);
  if (!saved) return;
  if (saved.lockedUntil + LEVEL_DECAY_MS < now) {
    deleteLockout(key);
    return;
  }
  attempts.set(key, {
    count: saved.lockedUntil > now ? FAILURE_THRESHOLD : 0,
    firstAttemptAt: saved.lockedUntil > now ? now : now - WINDOW_MS - 1,
    lockedUntil: saved.lockedUntil > now ? saved.lockedUntil : null,
    level: saved.level,
  });
}

const attempts: Map<string, AttemptState> = new Map();

// Above this many tracked IPs, opportunistically drop entries whose window has elapsed and
// that are not currently locked. Without this the map only ever grew (entries were deleted
// only on a *successful* login), so every distinct IP that ever failed a login leaked a
// permanent entry — unbounded under distributed brute-force. Expired/unlocked entries are
// already treated as "allowed", so removing them never changes a guard decision.
const PRUNE_THRESHOLD = 256;

function pruneExpiredAttempts(now: number): void {
  for (const [key, state] of attempts) {
    const windowElapsed = now - state.firstAttemptAt > WINDOW_MS;
    const notLocked = !state.lockedUntil || state.lockedUntil <= now;
    if (windowElapsed && notLocked) {
      attempts.delete(key);
      // Forget that it was loaded, so its persisted escalation level is read again if it returns.
      hydrated.delete(key);
    }
  }
}

export interface GuardDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
  /** Set when this failure started a lockout: how many lockouts in a row (1 = the first). */
  level?: number;
}

function nowMs(): number {
  return Date.now();
}

function clientKey(rawIp: string | null | undefined): string {
  const ip = (rawIp || "").trim();
  return ip || "__unknown__";
}

export function checkLoginGuard(
  rawIp: string | null | undefined,
  options: { enabled: boolean }
): GuardDecision {
  if (!options.enabled) return { allowed: true };
  const now = nowMs();
  hydrate(clientKey(rawIp), now);
  const state = attempts.get(clientKey(rawIp));
  if (!state) return { allowed: true };
  if (state.lockedUntil && state.lockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((state.lockedUntil - now) / 1000),
    };
  }
  return { allowed: true };
}

export function recordLoginFailure(
  rawIp: string | null | undefined,
  options: { enabled: boolean }
): GuardDecision {
  if (!options.enabled) return { allowed: true };
  const key = clientKey(rawIp);
  const now = nowMs();
  hydrate(key, now);

  // Keep the map from growing without bound as distinct IPs fail logins over time.
  if (attempts.size > PRUNE_THRESHOLD) pruneExpiredAttempts(now);

  const existing = attempts.get(key);
  const level = existing?.level ?? 0;

  if (!existing || now - existing.firstAttemptAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAttemptAt: now, lockedUntil: null, level });
    return { allowed: true };
  }

  const nextCount = existing.count + 1;
  if (nextCount >= FAILURE_THRESHOLD) {
    const nextLevel = level + 1;
    const duration = lockoutDurationMs(nextLevel);
    const lockedUntil = now + duration;
    attempts.set(key, {
      count: nextCount,
      firstAttemptAt: existing.firstAttemptAt,
      lockedUntil,
      level: nextLevel,
    });
    // The decision survives a restart; the counters do not need to.
    writeLockout(key, { level: nextLevel, lockedUntil });
    if (attempts.size > PRUNE_THRESHOLD) pruneLockouts(now, LEVEL_DECAY_MS);
    return { allowed: false, retryAfterSeconds: Math.ceil(duration / 1000), level: nextLevel };
  }

  attempts.set(key, {
    count: nextCount,
    firstAttemptAt: existing.firstAttemptAt,
    lockedUntil: null,
    level,
  });
  return { allowed: true };
}

/** A successful sign-in proves control of the account: counters and the escalation level reset. */
export function clearLoginAttempts(rawIp: string | null | undefined): void {
  const key = clientKey(rawIp);
  attempts.delete(key);
  hydrated.add(key);
  deleteLockout(key);
}

export function resetLoginGuardForTests(): void {
  attempts.clear();
  hydrated.clear();
  clearAllLockouts();
}

/** Test-only: forget everything held in memory, as a process restart does, keeping stored decisions. */
export function simulateRestartForTests(): void {
  attempts.clear();
  hydrated.clear();
}

/** Test-only: current number of tracked IP entries. */
export function getLoginGuardSizeForTests(): number {
  return attempts.size;
}

export const LOGIN_GUARD_TUNABLES = Object.freeze({
  WINDOW_MS,
  LOCKOUT_MS,
  LOCKOUT_STEPS_MS,
  LEVEL_DECAY_MS,
  FAILURE_THRESHOLD,
});
