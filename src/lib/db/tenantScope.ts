/**
 * db/tenantScope.ts — applies a key's tenant to its policy.
 *
 * Every request-time consumer (chat, embeddings, the model catalog, ...) already honours a key's
 * `allowedConnections` and `allowedCombos`. The tenant boundary is expressed through those same two
 * lists, computed live from the database on every read (never cached), so a resource moved between
 * tenants takes effect on the next request.
 *
 * The one trap: an EMPTY `allowedConnections` means "no restriction". A tenant with no connections
 * must therefore get a sentinel id that matches nothing, never `[]`.
 */

import { getDbInstance } from "./core";
import { ALL_COMBOS_ACCESS_RULE } from "@/shared/constants/comboAccess";
import { MANAGEMENT_API_KEY_SCOPES, MCP_CONNECT_SCOPE } from "@/shared/constants/managementScopes";

export const DEFAULT_TENANT = "red";
/** Matches no connection: an empty allow-list would mean "all connections". */
export const TENANT_NO_CONNECTIONS_ID = "tenant:no-connections";
// Kept literal (also exported by open-sse) so this leaf module needs no engine import.
const SYNTHETIC_NOAUTH_ID = "noauth";

interface ScopableMetadata {
  tenantId?: string;
  allowedConnections: string[];
  allowedCombos: string[];
  scopes: string[];
  isActive: boolean;
}

/** Scopes that reach instance-wide tooling (management API, MCP). A tenant key never holds them. */
export function isInstanceWideScope(scope: string): boolean {
  const value = scope.trim().toLowerCase();
  return MANAGEMENT_API_KEY_SCOPES.has(value) || value === MCP_CONNECT_SCOPE || value === "*";
}

function idsOf(sql: string, ...params: unknown[]): string[] {
  return (
    getDbInstance()
      .prepare(sql)
      .all(...params) as Array<{ v: string }>
  ).map((row) => row.v);
}

function sharedIds(kind: "connection" | "combo"): Set<string> {
  return new Set(
    idsOf("SELECT resource_id AS v FROM tenant_shared_resources WHERE kind = ?", kind)
  );
}

function comboAllowedByRules(name: string, rules: string[]): boolean {
  return rules.some(
    (rule) => rule === ALL_COMBOS_ACCESS_RULE || rule === name || rule === `combo/${name}`
  );
}

/**
 * Returns the metadata with the key's tenant applied. The input (which lives in a cache) is not
 * mutated. Default-tenant keys are untouched while no other tenant owns private resources, so a
 * single-tenant instance routes exactly as before.
 */
export function applyTenantScope<T extends ScopableMetadata>(metadata: T): T {
  const tenantId = metadata.tenantId || DEFAULT_TENANT;
  const db = getDbInstance();
  const tenant = db.prepare("SELECT disabled FROM tenants WHERE id = ?").get(tenantId) as
    { disabled: number } | undefined;

  // An unknown or disabled tenant fails closed: the key stops working.
  if (!tenant || Number(tenant.disabled) === 1) {
    return {
      ...metadata,
      tenantId,
      isActive: false,
      allowedConnections: [TENANT_NO_CONNECTIONS_ID],
      allowedCombos: [],
    };
  }

  const sharedConnections = sharedIds("connection");

  if (tenantId === DEFAULT_TENANT) {
    // Keep other tenants' private accounts out of the default tenant's pools (they would burn
    // another tenant's quota). Nothing to do until some tenant actually owns a private account.
    const foreign = idsOf(
      "SELECT id AS v FROM provider_connections WHERE tenant_id != ?",
      DEFAULT_TENANT
    ).filter((id) => !sharedConnections.has(id));
    if (foreign.length === 0) return { ...metadata, tenantId };
    const foreignSet = new Set(foreign);
    if (metadata.allowedConnections.length > 0) {
      const kept = metadata.allowedConnections.filter((id) => !foreignSet.has(id));
      return {
        ...metadata,
        tenantId,
        allowedConnections: kept.length > 0 ? kept : [TENANT_NO_CONNECTIONS_ID],
      };
    }
    const own = idsOf("SELECT id AS v FROM provider_connections WHERE tenant_id = ?", tenantId);
    // "noauth" stays in the list so the opt-in keyless providers keep working for this tenant.
    return {
      ...metadata,
      tenantId,
      allowedConnections: [...new Set([...own, ...sharedConnections, SYNTHETIC_NOAUTH_ID])],
    };
  }

  // Any other tenant: its own accounts plus the ones shared with it, narrowed by the key's list.
  const permittedConnections = new Set([
    ...idsOf("SELECT id AS v FROM provider_connections WHERE tenant_id = ?", tenantId),
    ...sharedConnections,
  ]);
  const connections =
    metadata.allowedConnections.length > 0
      ? metadata.allowedConnections.filter((id) => permittedConnections.has(id))
      : [...permittedConnections];

  const permittedCombos = new Set([
    ...idsOf("SELECT name AS v FROM combos WHERE tenant_id = ?", tenantId),
    ...idsOf(
      "SELECT c.name AS v FROM combos c JOIN tenant_shared_resources s ON s.kind = 'combo' AND s.resource_id = c.id"
    ),
  ]);
  const combos = [...permittedCombos].filter((name) =>
    comboAllowedByRules(name, metadata.allowedCombos)
  );

  return {
    ...metadata,
    tenantId,
    allowedConnections: connections.length > 0 ? connections : [TENANT_NO_CONNECTIONS_ID],
    allowedCombos: combos,
    // Defense in depth: a tenant key never reaches the management API, whatever its row says.
    scopes: metadata.scopes.filter((scope) => !isInstanceWideScope(scope)),
  };
}
