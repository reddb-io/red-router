/**
 * db/loginLockouts.ts — persisted sign-in lockout decisions (see migration 214).
 * Every function is best-effort: the guard keeps working from memory if the database is unavailable.
 */

import { getDbInstance } from "./core";

export interface LockoutRecord {
  level: number;
  lockedUntil: number;
}

export function readLockout(key: string): LockoutRecord | null {
  try {
    const row = getDbInstance()
      .prepare("SELECT level, locked_until FROM login_lockouts WHERE key = ?")
      .get(key) as { level: number; locked_until: number } | undefined;
    return row ? { level: Number(row.level), lockedUntil: Number(row.locked_until) } : null;
  } catch {
    return null;
  }
}

export function writeLockout(key: string, record: LockoutRecord): void {
  try {
    getDbInstance()
      .prepare(
        "INSERT OR REPLACE INTO login_lockouts (key, level, locked_until, updated_at) VALUES (?, ?, ?, ?)"
      )
      .run(key, record.level, record.lockedUntil, new Date().toISOString());
  } catch {
    // memory still enforces the lockout for this process
  }
}

export function deleteLockout(key: string): void {
  try {
    getDbInstance().prepare("DELETE FROM login_lockouts WHERE key = ?").run(key);
  } catch {
    // nothing to clean up
  }
}

export function clearAllLockouts(): void {
  try {
    getDbInstance().prepare("DELETE FROM login_lockouts").run();
  } catch {
    // nothing to clean up
  }
}

/** Drops decisions whose lock ended more than `olderThanMs` ago (their escalation level decays). */
export function pruneLockouts(now: number, olderThanMs: number): void {
  try {
    getDbInstance()
      .prepare("DELETE FROM login_lockouts WHERE locked_until < ?")
      .run(now - olderThanMs);
  } catch {
    // best effort
  }
}
