/**
 * db/tenants.ts — tenants, tenant users and the resources each tenant owns.
 *
 * A tenant is an isolated slice of the instance: its own API keys, provider connections, combos
 * and users. The default tenant "red" exists on every install and owns everything created before
 * tenants existed; its admin is the instance owner (the initial password login), which is not a
 * `tenant_users` row.
 */

import { v4 as uuidv4 } from "uuid";
import { getDbInstance } from "./core";
import { clearApiKeyCaches } from "./apiKeys";
import { isInstanceWideScope } from "./tenantScope";

export const DEFAULT_TENANT_ID = "red";
export const TENANT_ROLES = ["admin", "user"] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];
export type SharedResourceKind = "connection" | "combo";

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  isDefault: boolean;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TenantSummary extends Tenant {
  admins: number;
  users: number;
  apiKeys: number;
  connections: number;
  combos: number;
}

export interface TenantUser {
  id: string;
  tenantId: string;
  email: string;
  displayName: string | null;
  role: TenantRole;
  hasPassword: boolean;
  disabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class TenantError extends Error {
  code: "invalid" | "not_found" | "conflict" | "forbidden";
  constructor(code: TenantError["code"], message: string) {
    super(message);
    this.name = "TenantError";
    this.code = code;
  }
}

// Lower-case letters, digits and dashes; starts alphanumeric. Used in URLs, so kept strict.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

type Row = Record<string, unknown>;

function toTenant(row: Row): Tenant {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    isDefault: Number(row.is_default) === 1,
    disabled: Number(row.disabled) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toUser(row: Row): TenantUser {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    email: String(row.email),
    displayName: typeof row.display_name === "string" ? row.display_name : null,
    role: row.role === "admin" ? "admin" : "user",
    hasPassword: typeof row.password_hash === "string" && row.password_hash.length > 0,
    disabled: Number(row.disabled) === 1,
    lastLoginAt: typeof row.last_login_at === "string" ? row.last_login_at : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function normalizeTenantSlug(value: unknown): string {
  const slug = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SLUG_PATTERN.test(slug)) {
    throw new TenantError(
      "invalid",
      "Tenant slug must be 2-32 characters: lowercase letters, digits and dashes."
    );
  }
  return slug;
}

export function normalizeTenantEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!EMAIL_PATTERN.test(email)) {
    throw new TenantError("invalid", "A valid e-mail address is required.");
  }
  return email;
}

function normalizeName(value: unknown, fallback: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length > 80) throw new TenantError("invalid", "Name must be at most 80 characters.");
  return name || fallback;
}

/** Guarantees the default tenant row exists (a fresh DB gets it from migration 208). */
export function ensureDefaultTenant(): void {
  const db = getDbInstance();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, is_default, disabled, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?)"
  ).run(DEFAULT_TENANT_ID, DEFAULT_TENANT_ID, DEFAULT_TENANT_ID, now, now);
}

export function getTenant(idOrSlug: string): Tenant | null {
  const row = getDbInstance()
    .prepare("SELECT * FROM tenants WHERE id = ? OR slug = ?")
    .get(idOrSlug, idOrSlug) as Row | undefined;
  return row ? toTenant(row) : null;
}

function count(sql: string, ...params: unknown[]): number {
  const row = getDbInstance()
    .prepare(sql)
    .get(...params) as { n: number };
  return row?.n ?? 0;
}

export function listTenants(): TenantSummary[] {
  const rows = getDbInstance()
    .prepare("SELECT * FROM tenants ORDER BY is_default DESC, created_at ASC")
    .all() as Row[];
  return rows.map((row) => {
    const tenant = toTenant(row);
    return {
      ...tenant,
      admins: count(
        "SELECT COUNT(*) AS n FROM tenant_users WHERE tenant_id = ? AND role = 'admin'",
        tenant.id
      ),
      users: count("SELECT COUNT(*) AS n FROM tenant_users WHERE tenant_id = ?", tenant.id),
      apiKeys: count("SELECT COUNT(*) AS n FROM api_keys WHERE tenant_id = ?", tenant.id),
      connections: count(
        "SELECT COUNT(*) AS n FROM provider_connections WHERE tenant_id = ?",
        tenant.id
      ),
      combos: count("SELECT COUNT(*) AS n FROM combos WHERE tenant_id = ?", tenant.id),
    };
  });
}

export function createTenant(input: { slug: unknown; name?: unknown }): Tenant {
  const slug = normalizeTenantSlug(input.slug);
  const name = normalizeName(input.name, slug);
  if (getTenant(slug)) throw new TenantError("conflict", "A tenant with this slug already exists.");
  const now = new Date().toISOString();
  const id = uuidv4();
  getDbInstance()
    .prepare(
      "INSERT INTO tenants (id, slug, name, is_default, disabled, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?)"
    )
    .run(id, slug, name, now, now);
  return getTenant(id)!;
}

export function updateTenant(id: string, patch: { name?: unknown; disabled?: unknown }): Tenant {
  const tenant = getTenant(id);
  if (!tenant) throw new TenantError("not_found", "Tenant not found.");
  const name = patch.name === undefined ? tenant.name : normalizeName(patch.name, tenant.name);
  const disabled = patch.disabled === undefined ? tenant.disabled : patch.disabled === true;
  if (tenant.isDefault && disabled) {
    throw new TenantError("forbidden", "The default tenant cannot be disabled.");
  }
  getDbInstance()
    .prepare("UPDATE tenants SET name = ?, disabled = ?, updated_at = ? WHERE id = ?")
    .run(name, disabled ? 1 : 0, new Date().toISOString(), tenant.id);
  // A disabled flag changes every key's effective policy.
  clearApiKeyCaches();
  return getTenant(tenant.id)!;
}

/** Deletes an empty tenant. Resources must be moved or deleted first: nothing is orphaned. */
export function deleteTenant(id: string): void {
  const tenant = getTenant(id);
  if (!tenant) throw new TenantError("not_found", "Tenant not found.");
  if (tenant.isDefault) throw new TenantError("forbidden", "The default tenant cannot be deleted.");
  const owned =
    count("SELECT COUNT(*) AS n FROM api_keys WHERE tenant_id = ?", tenant.id) +
    count("SELECT COUNT(*) AS n FROM provider_connections WHERE tenant_id = ?", tenant.id) +
    count("SELECT COUNT(*) AS n FROM combos WHERE tenant_id = ?", tenant.id);
  if (owned > 0) {
    throw new TenantError(
      "conflict",
      "This tenant still owns API keys, connections or combos. Move or delete them first."
    );
  }
  getDbInstance().prepare("DELETE FROM tenants WHERE id = ?").run(tenant.id);
}

export function listTenantUsers(tenantId: string): TenantUser[] {
  const rows = getDbInstance()
    .prepare("SELECT * FROM tenant_users WHERE tenant_id = ? ORDER BY role ASC, email ASC")
    .all(tenantId) as Row[];
  return rows.map(toUser);
}

export function getTenantUser(id: string): TenantUser | null {
  const row = getDbInstance().prepare("SELECT * FROM tenant_users WHERE id = ?").get(id) as
    Row | undefined;
  return row ? toUser(row) : null;
}

export function getTenantUserByEmail(email: string): TenantUser | null {
  const row = getDbInstance()
    .prepare("SELECT * FROM tenant_users WHERE email = ?")
    .get(String(email).trim().toLowerCase()) as Row | undefined;
  return row ? toUser(row) : null;
}

export function createTenantUser(
  tenantId: string,
  input: { email: unknown; displayName?: unknown; role?: unknown }
): TenantUser {
  const tenant = getTenant(tenantId);
  if (!tenant) throw new TenantError("not_found", "Tenant not found.");
  const email = normalizeTenantEmail(input.email);
  const role: TenantRole = input.role === "admin" ? "admin" : "user";
  if (input.role !== undefined && !TENANT_ROLES.includes(input.role as TenantRole)) {
    throw new TenantError("invalid", "Role must be 'admin' or 'user'.");
  }
  if (getTenantUserByEmail(email)) {
    throw new TenantError("conflict", "A user with this e-mail already exists.");
  }
  const displayName = normalizeName(input.displayName, "") || null;
  const now = new Date().toISOString();
  const id = uuidv4();
  getDbInstance()
    .prepare(
      "INSERT INTO tenant_users (id, tenant_id, email, display_name, role, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)"
    )
    .run(id, tenant.id, email, displayName, role, now, now);
  return getTenantUser(id)!;
}

export function updateTenantUser(
  tenantId: string,
  userId: string,
  patch: { displayName?: unknown; role?: unknown; disabled?: unknown }
): TenantUser {
  const user = getTenantUser(userId);
  if (!user || user.tenantId !== tenantId) throw new TenantError("not_found", "User not found.");
  if (patch.role !== undefined && !TENANT_ROLES.includes(patch.role as TenantRole)) {
    throw new TenantError("invalid", "Role must be 'admin' or 'user'.");
  }
  const role = (patch.role as TenantRole | undefined) ?? user.role;
  const disabled = patch.disabled === undefined ? user.disabled : patch.disabled === true;
  const displayName =
    patch.displayName === undefined
      ? user.displayName
      : normalizeName(patch.displayName, "") || null;
  // A role or status change ends the user's live sessions at once.
  const endsSessions = role !== user.role || disabled !== user.disabled;
  getDbInstance()
    .prepare(
      "UPDATE tenant_users SET display_name = ?, role = ?, disabled = ?, session_version = session_version + ?, updated_at = ? WHERE id = ?"
    )
    .run(
      displayName,
      role,
      disabled ? 1 : 0,
      endsSessions ? 1 : 0,
      new Date().toISOString(),
      user.id
    );
  return getTenantUser(user.id)!;
}

export function deleteTenantUser(tenantId: string, userId: string): void {
  const user = getTenantUser(userId);
  if (!user || user.tenantId !== tenantId) throw new TenantError("not_found", "User not found.");
  getDbInstance().prepare("DELETE FROM tenant_users WHERE id = ?").run(user.id);
}

const RESOURCE_TABLES: Record<SharedResourceKind, { table: string; key: string }> = {
  connection: { table: "provider_connections", key: "id" },
  combo: { table: "combos", key: "id" },
};

/** Moves connections / combos to a tenant. Their sharing marks are cleared: sharing is re-opted. */
export function assignResourcesToTenant(
  tenantId: string,
  resources: { connectionIds?: string[]; comboIds?: string[] }
): { connections: number; combos: number } {
  const tenant = getTenant(tenantId);
  if (!tenant) throw new TenantError("not_found", "Tenant not found.");
  const db = getDbInstance();
  const moved = { connections: 0, combos: 0 };
  const run = db.transaction(() => {
    for (const [kind, ids] of [
      ["connection", resources.connectionIds ?? []],
      ["combo", resources.comboIds ?? []],
    ] as const) {
      const { table, key } = RESOURCE_TABLES[kind];
      for (const id of ids) {
        const changed = db
          .prepare(`UPDATE ${table} SET tenant_id = ? WHERE ${key} = ?`)
          .run(tenant.id, id).changes;
        if (changed > 0) {
          db.prepare("DELETE FROM tenant_shared_resources WHERE kind = ? AND resource_id = ?").run(
            kind,
            id
          );
          if (kind === "connection") moved.connections += 1;
          else moved.combos += 1;
        }
      }
    }
  });
  run();
  clearApiKeyCaches();
  return moved;
}

/** Moves API keys to a tenant. Keys with instance-wide scopes cannot leave the default tenant. */
export function assignApiKeysToTenant(tenantId: string, keyIds: string[]): number {
  const tenant = getTenant(tenantId);
  if (!tenant) throw new TenantError("not_found", "Tenant not found.");
  const db = getDbInstance();
  let moved = 0;
  const run = db.transaction(() => {
    for (const id of keyIds) {
      const row = db.prepare("SELECT scopes FROM api_keys WHERE id = ?").get(id) as
        { scopes: string | null } | undefined;
      if (!row) continue;
      if (!tenant.isDefault && hasInstanceWideScope(row.scopes)) {
        throw new TenantError(
          "forbidden",
          "A key with the 'manage' or 'admin' scope reaches the whole instance and cannot belong to a tenant."
        );
      }
      moved += db
        .prepare("UPDATE api_keys SET tenant_id = ? WHERE id = ?")
        .run(tenant.id, id).changes;
    }
  });
  run();
  clearApiKeyCaches();
  return moved;
}

/** Scopes that reach instance-wide tooling. A tenant key must never hold them. */
export function hasInstanceWideScope(scopes: unknown): boolean {
  let list: unknown = scopes;
  if (typeof scopes === "string") {
    try {
      list = JSON.parse(scopes);
    } catch {
      list = scopes.split(",");
    }
  }
  return Array.isArray(list) && list.some((scope) => isInstanceWideScope(String(scope)));
}

export function setResourceShared(
  kind: SharedResourceKind,
  resourceId: string,
  shared: boolean
): void {
  const db = getDbInstance();
  if (shared) {
    const { table, key } = RESOURCE_TABLES[kind];
    const exists = db.prepare(`SELECT 1 FROM ${table} WHERE ${key} = ?`).get(resourceId);
    if (!exists) throw new TenantError("not_found", "Resource not found.");
    db.prepare(
      "INSERT OR IGNORE INTO tenant_shared_resources (kind, resource_id, created_at) VALUES (?, ?, ?)"
    ).run(kind, resourceId, new Date().toISOString());
  } else {
    db.prepare("DELETE FROM tenant_shared_resources WHERE kind = ? AND resource_id = ?").run(
      kind,
      resourceId
    );
  }
  clearApiKeyCaches();
}

export function listSharedResourceIds(kind: SharedResourceKind): string[] {
  return (
    getDbInstance()
      .prepare("SELECT resource_id FROM tenant_shared_resources WHERE kind = ?")
      .all(kind) as Array<{ resource_id: string }>
  ).map((row) => row.resource_id);
}

/** The tenant that owns a connection or combo, or null when the resource does not exist. */
export function getResourceTenantId(kind: SharedResourceKind, resourceId: string): string | null {
  const { table, key } = RESOURCE_TABLES[kind];
  const row = getDbInstance()
    .prepare(`SELECT tenant_id FROM ${table} WHERE ${key} = ?`)
    .get(resourceId) as { tenant_id: string } | undefined;
  return row ? row.tenant_id : null;
}

export interface TenantResourceRow {
  id: string;
  name: string;
  tenantId: string;
  shared: boolean;
  detail?: string;
}

export interface TenantResources {
  connections: TenantResourceRow[];
  combos: TenantResourceRow[];
  apiKeys: TenantResourceRow[];
}

/** Every key, connection and combo with the tenant that owns it. Secrets are never selected. */
export function listAllTenantResources(): TenantResources {
  const db = getDbInstance();
  const sharedConnections = new Set(listSharedResourceIds("connection"));
  const sharedCombos = new Set(listSharedResourceIds("combo"));
  const connections = (
    db
      .prepare(
        "SELECT id, name, provider, tenant_id FROM provider_connections ORDER BY provider, name"
      )
      .all() as Row[]
  ).map((row) => ({
    id: String(row.id),
    name: typeof row.name === "string" && row.name ? row.name : String(row.id),
    detail: String(row.provider ?? ""),
    tenantId: String(row.tenant_id),
    shared: sharedConnections.has(String(row.id)),
  }));
  const combos = (
    db.prepare("SELECT id, name, tenant_id FROM combos ORDER BY name").all() as Row[]
  ).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    tenantId: String(row.tenant_id),
    shared: sharedCombos.has(String(row.id)),
  }));
  const apiKeys = (
    db.prepare("SELECT id, name, tenant_id, key_prefix FROM api_keys ORDER BY name").all() as Row[]
  ).map((row) => ({
    id: String(row.id),
    name: typeof row.name === "string" && row.name ? row.name : String(row.id),
    detail: typeof row.key_prefix === "string" ? row.key_prefix : undefined,
    tenantId: String(row.tenant_id),
    shared: false,
  }));
  return { connections, combos, apiKeys };
}

export interface TenantApiKeyRow {
  id: string;
  name: string;
  prefix: string | null;
  isActive: boolean;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

/** The keys of one tenant, without the key value or its hash. */
export function listTenantApiKeys(tenantId: string): TenantApiKeyRow[] {
  const rows = getDbInstance()
    .prepare(
      "SELECT id, name, key_prefix, is_active, created_at, expires_at, last_used_at FROM api_keys WHERE tenant_id = ? ORDER BY created_at"
    )
    .all(tenantId) as Row[];
  return rows.map((row) => ({
    id: String(row.id),
    name: typeof row.name === "string" ? row.name : String(row.id),
    prefix: typeof row.key_prefix === "string" ? row.key_prefix : null,
    isActive:
      row.is_active === null || row.is_active === undefined ? true : Number(row.is_active) === 1,
    createdAt: String(row.created_at),
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
    lastUsedAt: typeof row.last_used_at === "string" ? row.last_used_at : null,
  }));
}
