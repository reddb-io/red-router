/**
 * db/tenantAuth.ts — credentials, session versions and invitations of tenant users.
 * Kept apart from db/tenants.ts so the password hash never travels with the ordinary user rows.
 */

import { createHash, randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getDbInstance } from "./core";

export interface TenantUserAuth {
  id: string;
  tenantId: string;
  email: string;
  role: "admin" | "user";
  disabled: boolean;
  passwordHash: string | null;
  sessionVersion: number;
}

type Row = Record<string, unknown>;

function toAuth(row: Row | undefined): TenantUserAuth | null {
  if (!row) return null;
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    email: String(row.email),
    role: row.role === "admin" ? "admin" : "user",
    disabled: Number(row.disabled) === 1,
    passwordHash:
      typeof row.password_hash === "string" && row.password_hash.length > 0
        ? row.password_hash
        : null,
    sessionVersion: Number(row.session_version ?? 0),
  };
}

export function getTenantUserAuthById(id: string): TenantUserAuth | null {
  return toAuth(
    getDbInstance().prepare("SELECT * FROM tenant_users WHERE id = ?").get(id) as Row | undefined
  );
}

export function getTenantUserAuthByEmail(email: string): TenantUserAuth | null {
  return toAuth(
    getDbInstance()
      .prepare("SELECT * FROM tenant_users WHERE email = ?")
      .get(String(email).trim().toLowerCase()) as Row | undefined
  );
}

/** Sets the password and ends every live session of the user. */
export function setTenantUserPassword(userId: string, passwordHash: string): void {
  getDbInstance()
    .prepare(
      "UPDATE tenant_users SET password_hash = ?, session_version = session_version + 1, updated_at = ? WHERE id = ?"
    )
    .run(passwordHash, new Date().toISOString(), userId);
}

/** Ends every live session of the user ("sign out everywhere", role change, disable). */
export function bumpTenantUserSessionVersion(userId: string): void {
  getDbInstance()
    .prepare(
      "UPDATE tenant_users SET session_version = session_version + 1, updated_at = ? WHERE id = ?"
    )
    .run(new Date().toISOString(), userId);
}

export function touchTenantUserLogin(userId: string): void {
  getDbInstance()
    .prepare("UPDATE tenant_users SET last_login_at = ? WHERE id = ?")
    .run(new Date().toISOString(), userId);
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * A fresh invitation for a user. Earlier pending invitations of the same user stop working. The
 * token is returned once and only its hash is stored.
 */
export function createTenantInvite(input: {
  tenantId: string;
  userId: string;
  createdBy: string;
  ttlMs?: number;
}): { token: string; expiresAt: string } {
  const db = getDbInstance();
  const token = `rri_${randomBytes(32).toString("base64url")}`;
  const now = Date.now();
  const expiresAt = new Date(now + (input.ttlMs ?? INVITE_TTL_MS)).toISOString();
  db.transaction(() => {
    db.prepare(
      "UPDATE tenant_invites SET expires_at = ? WHERE user_id = ? AND accepted_at IS NULL"
    ).run(new Date(0).toISOString(), input.userId);
    db.prepare(
      "INSERT INTO tenant_invites (id, tenant_id, user_id, token_hash, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      uuidv4(),
      input.tenantId,
      input.userId,
      hashToken(token),
      expiresAt,
      input.createdBy,
      new Date(now).toISOString()
    );
  })();
  return { token, expiresAt };
}

/** Spends an invitation. Atomic: a token works once, and only before it expires. */
export function consumeTenantInvite(token: string): { userId: string; tenantId: string } | null {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const db = getDbInstance();
  const digest = hashToken(token);
  const nowIso = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE tenant_invites SET accepted_at = ? WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?"
    )
    .run(nowIso, digest, nowIso);
  if (result.changes !== 1) return null;
  const row = db
    .prepare("SELECT user_id, tenant_id FROM tenant_invites WHERE token_hash = ?")
    .get(digest) as { user_id: string; tenant_id: string } | undefined;
  return row ? { userId: row.user_id, tenantId: row.tenant_id } : null;
}
