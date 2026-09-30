import { z } from "zod";
import { getDbInstance } from "./core";
import { getTenant, getTenantUser, TenantError } from "./tenants";

const email = z.union([z.literal(""), z.string().trim().email().max(254)]);
export const tenantProfileSchema = z
  .object({
    ownerUserId: z.string().min(1).max(128).nullable().default(null),
    ownerEmail: email.default(""),
    technicalEmail: email.default(""),
    billingEmail: email.default(""),
    description: z.string().trim().max(2000).default(""),
    metadata: z.record(z.string().trim().min(1).max(80), z.string().max(500)).default({}),
  })
  .refine((profile) => Object.keys(profile.metadata).length <= 20, {
    message: "Use at most 20 metadata fields",
  });
export type TenantProfile = z.infer<typeof tenantProfileSchema>;

export function getTenantProfile(tenantId: string): TenantProfile {
  const row = getDbInstance()
    .prepare("SELECT * FROM tenant_profiles WHERE tenant_id = ?")
    .get(tenantId) as Record<string, unknown> | undefined;
  if (!row) return tenantProfileSchema.parse({});
  try {
    return tenantProfileSchema.parse({
      ownerUserId: row.owner_user_id,
      ownerEmail: row.owner_email,
      technicalEmail: row.technical_email,
      billingEmail: row.billing_email,
      description: row.description,
      metadata: JSON.parse(String(row.metadata)),
    });
  } catch {
    throw new TenantError("invalid", "Tenant profile is invalid.");
  }
}

export function saveTenantProfile(tenantId: string, input: unknown): TenantProfile {
  const parsed = tenantProfileSchema.safeParse(input);
  if (!parsed.success) throw new TenantError("invalid", "Invalid tenant profile.");
  const profile = parsed.data;
  const db = getDbInstance();
  db.transaction(() => {
    if (!getTenant(tenantId)) throw new TenantError("not_found", "Tenant not found.");
    if (profile.ownerUserId) {
      const user = getTenantUser(profile.ownerUserId);
      if (!user || user.tenantId !== tenantId || user.disabled || user.role !== "admin") {
        throw new TenantError(
          "invalid",
          "The tenant owner must be an active admin of this tenant."
        );
      }
    }
    db.prepare(
      `INSERT INTO tenant_profiles (tenant_id, owner_user_id, owner_email, technical_email,
      billing_email, description, metadata, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,
      owner_email=excluded.owner_email, technical_email=excluded.technical_email,
      billing_email=excluded.billing_email, description=excluded.description,
      metadata=excluded.metadata, updated_at=excluded.updated_at`
    ).run(
      tenantId,
      profile.ownerUserId,
      profile.ownerEmail,
      profile.technicalEmail,
      profile.billingEmail,
      profile.description,
      JSON.stringify(profile.metadata),
      new Date().toISOString()
    );
  })();
  return profile;
}

export interface AccessUser {
  id: string;
  tenantId: string;
  email: string;
  displayName: string | null;
  role: "admin" | "user";
  disabled: boolean;
  lastLoginAt: string | null;
  tenantName: string;
  tenantSlug: string;
  isOwner: boolean;
}

export function listAccessUsers(tenantId?: string): AccessUser[] {
  return getDbInstance()
    .prepare(
      `SELECT u.id, u.tenant_id AS tenantId, u.email,
    u.display_name AS displayName, u.role, u.disabled, u.last_login_at AS lastLoginAt,
    t.name AS tenantName, t.slug AS tenantSlug,
    CASE WHEN p.owner_user_id = u.id THEN 1 ELSE 0 END AS isOwner
    FROM tenant_users u JOIN tenants t ON t.id = u.tenant_id
    LEFT JOIN tenant_profiles p ON p.tenant_id = u.tenant_id
    ${tenantId ? "WHERE u.tenant_id = ?" : ""} ORDER BY t.name, u.email`
    )
    .all(...(tenantId ? [tenantId] : []))
    .map((row: Record<string, unknown>) => ({
      id: String(row.id),
      tenantId: String(row.tenantId),
      email: String(row.email),
      displayName: row.displayName == null ? null : String(row.displayName),
      role: row.role === "admin" ? ("admin" as const) : ("user" as const),
      lastLoginAt: row.lastLoginAt == null ? null : String(row.lastLoginAt),
      tenantName: String(row.tenantName),
      tenantSlug: String(row.tenantSlug),
      disabled: Number(row.disabled) === 1,
      isOwner: Number(row.isOwner) === 1,
    }));
}
