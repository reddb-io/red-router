/**
 * db/mfa.ts — the second factor (TOTP + recovery codes) of a principal.
 *
 * `principal` is 'owner' (the instance administrator) today and `user:<id>` for tenant users later.
 * The secret is encrypted at rest and never returned after setup. A row with enabled = 0 is a setup
 * in progress: it does not gate sign-in until a valid code proves the authenticator was set up.
 */

import { getDbInstance } from "./core";
import { decrypt, encrypt } from "./encryption";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  verifyTotp,
} from "@/lib/auth/totp";

export const OWNER_PRINCIPAL = "owner";

interface MfaRow {
  principal: string;
  secret_encrypted: string;
  recovery_hashes: string;
  enabled: number;
  last_used_step: number | null;
}

export interface MfaState {
  enabled: boolean;
  pendingSetup: boolean;
  recoveryCodesRemaining: number;
}

function readRow(principal: string): MfaRow | undefined {
  return getDbInstance().prepare("SELECT * FROM auth_mfa WHERE principal = ?").get(principal) as
    MfaRow | undefined;
}

function parseHashes(raw: string | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === "string") : [];
  } catch {
    return [];
  }
}

export function isMfaEnabled(principal: string): boolean {
  return readRow(principal)?.enabled === 1;
}

export function getMfaState(principal: string): MfaState {
  const row = readRow(principal);
  return {
    enabled: row?.enabled === 1,
    pendingSetup: row !== undefined && row.enabled !== 1,
    recoveryCodesRemaining: row?.enabled === 1 ? parseHashes(row.recovery_hashes).length : 0,
  };
}

/** Starts (or restarts) a setup. Refused while a second factor is already active. */
export function beginMfaSetup(principal: string): { secret: string } | null {
  if (isMfaEnabled(principal)) return null;
  const secret = generateTotpSecret();
  const now = new Date().toISOString();
  getDbInstance()
    .prepare(
      `INSERT OR REPLACE INTO auth_mfa
         (principal, secret_encrypted, recovery_hashes, enabled, last_used_step, created_at, updated_at)
       VALUES (?, ?, '[]', 0, NULL, ?, ?)`
    )
    .run(principal, String(encrypt(secret)), now, now);
  return { secret };
}

function secretOf(row: MfaRow): string {
  return String(decrypt(row.secret_encrypted) ?? "");
}

/** Claims the step so the same code cannot be used twice; false when it was already taken. */
function claimStep(principal: string, step: number): boolean {
  const changed = getDbInstance()
    .prepare(
      "UPDATE auth_mfa SET last_used_step = ?, updated_at = ? WHERE principal = ? AND (last_used_step IS NULL OR last_used_step < ?)"
    )
    .run(step, new Date().toISOString(), principal, step).changes;
  return changed === 1;
}

/** Proves the authenticator was set up, turns the second factor on and returns the recovery codes once. */
export function enableMfa(principal: string, code: string): { recoveryCodes: string[] } | null {
  const row = readRow(principal);
  if (!row || row.enabled === 1) return null;
  const step = verifyTotp(secretOf(row), code, { lastUsedStep: row.last_used_step });
  if (step === null) return null;
  const recoveryCodes = generateRecoveryCodes();
  getDbInstance()
    .prepare(
      "UPDATE auth_mfa SET enabled = 1, recovery_hashes = ?, last_used_step = ?, updated_at = ? WHERE principal = ?"
    )
    .run(
      JSON.stringify(recoveryCodes.map(hashRecoveryCode)),
      step,
      new Date().toISOString(),
      principal
    );
  return { recoveryCodes };
}

export type MfaProof = { code?: string; recoveryCode?: string };

/** Checks a TOTP code or spends one recovery code. Only an ENABLED second factor can be proven. */
export function verifyMfaProof(principal: string, proof: MfaProof): "totp" | "recovery" | null {
  const row = readRow(principal);
  if (!row || row.enabled !== 1) return null;

  if (typeof proof.code === "string" && proof.code.trim() !== "") {
    const step = verifyTotp(secretOf(row), proof.code, { lastUsedStep: row.last_used_step });
    return step !== null && claimStep(principal, step) ? "totp" : null;
  }

  if (typeof proof.recoveryCode === "string" && proof.recoveryCode.trim() !== "") {
    const digest = hashRecoveryCode(proof.recoveryCode);
    const db = getDbInstance();
    const spend = db.transaction(() => {
      const fresh = readRow(principal);
      const hashes = parseHashes(fresh?.recovery_hashes);
      const index = hashes.indexOf(digest);
      if (index === -1) return false;
      hashes.splice(index, 1);
      db.prepare("UPDATE auth_mfa SET recovery_hashes = ?, updated_at = ? WHERE principal = ?").run(
        JSON.stringify(hashes),
        new Date().toISOString(),
        principal
      );
      return true;
    });
    return spend() ? "recovery" : null;
  }
  return null;
}

/** Replaces the recovery codes (the caller has already proven a second-factor code). */
export function regenerateRecoveryCodes(principal: string): string[] | null {
  const row = readRow(principal);
  if (!row || row.enabled !== 1) return null;
  const codes = generateRecoveryCodes();
  getDbInstance()
    .prepare("UPDATE auth_mfa SET recovery_hashes = ?, updated_at = ? WHERE principal = ?")
    .run(JSON.stringify(codes.map(hashRecoveryCode)), new Date().toISOString(), principal);
  return codes;
}

export function disableMfa(principal: string): void {
  getDbInstance().prepare("DELETE FROM auth_mfa WHERE principal = ?").run(principal);
}
