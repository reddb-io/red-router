/**
 * db/routingPolicy.ts — the per-tenant routing policy rows (migration 217).
 * `owner_*` columns hold what the instance owner pinned for the tenant, `tenant_*` what the tenant's
 * admin chose. Resolution (who wins) lives in lib/routing/routingPolicy.ts.
 */

import { getDbInstance } from "./core";
import { invalidateDbCache } from "./readCache";

export interface TenantRoutingRow {
  tenantId: string;
  ownerTransparent: boolean | null;
  ownerPriority: string[] | null;
  tenantTransparent: boolean | null;
  tenantPriority: string[] | null;
}

type Row = Record<string, unknown>;

function parseList(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}

function toBool(value: unknown): boolean | null {
  return value === null || value === undefined ? null : Number(value) === 1;
}

function fromRow(row: Row): TenantRoutingRow {
  return {
    tenantId: String(row.tenant_id),
    ownerTransparent: toBool(row.owner_transparent),
    ownerPriority: parseList(row.owner_priority),
    tenantTransparent: toBool(row.tenant_transparent),
    tenantPriority: parseList(row.tenant_priority),
  };
}

export function getTenantRoutingRow(tenantId: string): TenantRoutingRow | null {
  const row = getDbInstance()
    .prepare("SELECT * FROM tenant_routing_policy WHERE tenant_id = ?")
    .get(tenantId) as Row | undefined;
  return row ? fromRow(row) : null;
}

export type RoutingSide = "owner" | "tenant";

export interface RoutingPatch {
  /** undefined = leave as is, null = clear, boolean = set. */
  transparent?: boolean | null;
  /** undefined = leave as is, null = clear, array = set. */
  priority?: string[] | null;
}

/** Sets or clears one side's values for a tenant, keeping the other side untouched. */
export function setTenantRoutingSide(
  tenantId: string,
  side: RoutingSide,
  patch: RoutingPatch
): TenantRoutingRow {
  const db = getDbInstance();
  const current = getTenantRoutingRow(tenantId);
  const next = {
    ownerTransparent: current?.ownerTransparent ?? null,
    ownerPriority: current?.ownerPriority ?? null,
    tenantTransparent: current?.tenantTransparent ?? null,
    tenantPriority: current?.tenantPriority ?? null,
  };
  const tKey = side === "owner" ? "ownerTransparent" : "tenantTransparent";
  const pKey = side === "owner" ? "ownerPriority" : "tenantPriority";
  if (patch.transparent !== undefined) next[tKey] = patch.transparent;
  if (patch.priority !== undefined) next[pKey] = patch.priority;

  db.prepare(
    `INSERT OR REPLACE INTO tenant_routing_policy
       (tenant_id, owner_transparent, owner_priority, tenant_transparent, tenant_priority, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    tenantId,
    next.ownerTransparent === null ? null : next.ownerTransparent ? 1 : 0,
    next.ownerPriority === null ? null : JSON.stringify(next.ownerPriority),
    next.tenantTransparent === null ? null : next.tenantTransparent ? 1 : 0,
    next.tenantPriority === null ? null : JSON.stringify(next.tenantPriority),
    new Date().toISOString()
  );
  // The model catalog is cached per key: a policy change must show on the very next read.
  invalidateDbCache("settings");
  return getTenantRoutingRow(tenantId)!;
}

export interface RoutableProvider {
  provider: string;
  connections: number;
}

/**
 * The providers that have at least one active connection a tenant can use (its own plus the ones the
 * owner shared), or, with no tenant, every active connection of the instance.
 */
export function listRoutableProviders(tenantId: string | null): RoutableProvider[] {
  const rows = (
    tenantId === null
      ? getDbInstance()
          .prepare(
            "SELECT provider, COUNT(*) AS n FROM provider_connections WHERE is_active = 1 GROUP BY provider ORDER BY provider"
          )
          .all()
      : getDbInstance()
          .prepare(
            `SELECT provider, COUNT(*) AS n FROM provider_connections
              WHERE is_active = 1
                AND (tenant_id = ? OR id IN (SELECT resource_id FROM tenant_shared_resources WHERE kind = 'connection'))
              GROUP BY provider ORDER BY provider`
          )
          .all(tenantId)
  ) as Array<{ provider: string; n: number }>;
  return rows.map((row) => ({ provider: String(row.provider), connections: Number(row.n) }));
}
