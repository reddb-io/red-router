/**
 * db/fridayImport.ts — brings a RedRouter v0.33.0 ("Friday") install into this database.
 *
 * Friday kept everything in `<DATA_DIR>/data.sqlite` (camelCase tables, one JSON `data`
 * column per connection). This build opens `<DATA_DIR>/storage.sqlite` and never read the
 * old file, so an in-place upgrade booted empty. The importer copies `data.sqlite` (plus its
 * WAL) into `backups/friday-<stamp>/`, reads the COPY, maps it onto the current schema and
 * writes a marker. The original file and any legacy JSON are never modified or deleted.
 *
 * Nothing is silently dropped: every Friday field that has no mapping yet is counted in the
 * report, so a later slice can restore it and re-run the import.
 */

import fs from "node:fs";
import path from "node:path";
import { getDbInstance } from "./core";
import { tryOpenSync } from "./adapters/driverFactory";
import type { SqliteAdapter } from "./adapters/types";
import { runJsonMigration, type LegacyJsonData } from "./jsonMigration";
import { resolveProviderAlias } from "@omniroute/open-sse/services/providerAlias";
import { normalizeRoutingStrategy } from "@/shared/constants/routingStrategies";
import { ALL_COMBOS_ACCESS_RULE } from "@/shared/constants/comboAccess";
import { normalizeComboRecord } from "@/lib/combos/steps";
import { validateComboInvariant } from "@/lib/combos/invariants";
import { ensureApiKeysSchema } from "./apiKeys";
import { assignProxyToScope, createProxy, getProxyAssignments, listProxies } from "./proxies";
import type { ProxyPayload } from "./proxies/types";
import { decodeUserinfo } from "@/shared/utils/decodeUserinfo";
import { hashKey } from "./apiKeys/keyHash";
import { snapshotApiKeyTags, insertInitialApiKeyTagsInTransaction } from "./apiKeys/tags";
import {
  insertInitialApiKeyModelIdFormatInTransaction,
  validateApiKeyModelIdFormat,
} from "./apiKeys/idFormat";
import {
  insertInitialKeyQuotaLimitsInTransaction,
  snapshotInitialKeyQuotaLimits,
} from "./keyQuota";

export const FRIDAY_DATABASE_FILE = "data.sqlite";
export const FRIDAY_IMPORT_MARKER = ".migrated-from-friday";
export const FRIDAY_IMPORT_REPORT = "friday-import-report.json";

type Row = Record<string, unknown>;

export interface FridayImportReport {
  source: string;
  backup: string | null;
  dryRun: boolean;
  imported: {
    connections: number;
    apiKeys: number;
    combos: number;
    usageHistory: number;
    settings: number;
    modelAliases: number;
    customModels: number;
    /** Friday proxy pools that now exist as registry proxies (created or already present). */
    proxies: number;
    /** Connection-level proxy assignments written by this run (a dry run reports the projection). */
    proxyAssignments: number;
    /** Owners, scope/SSO settings and user preferences carried into the staging namespace. */
    legacyStaged: number;
  };
  warnings: string[];
  /** Friday data the importer read but has no mapping for yet, by name → count. */
  notMapped: Record<string, number>;
  providers: string[];
}

// Friday's per-user scoping (owners of connections, keys and combos, the scope and SSO settings,
// per-owner overrides and per-user preferences) has no model in this build yet. It is carried into
// a staging namespace so nothing is lost and the users/tenants migration can read it later.
export const FRIDAY_LEGACY_NAMESPACE = "friday_legacy";
const LEGACY_SETTING_KEYS = new Set([
  "scopeResourcesByUser",
  "ssoAdminEmails",
  "authMode",
  "ssoType",
  "tokenSaverByOwner",
  "capacityAdapterByOwner",
]);
const LEGACY_SETTING_PREFIX = /^(oidc|saml|sso)/i;
const SECRET_LOOKING = /secret|password|private|cert|token|credential/i;
const LEGACY_KV_SCOPES = new Set(["disabledSharedAccounts", "hiddenGlobalCombos"]);

export interface FridayLegacyState {
  owners: {
    providerConnections: Record<string, string>;
    apiKeys: Record<string, string>;
    combos: Record<string, string>;
  };
  settings: Record<string, unknown>;
  preferences: Record<string, Record<string, unknown>>;
}

/** What of Friday's user scoping to stage. Secrets are never staged: they are reported instead. */
export function collectFridayLegacy(input: {
  connections: Row[];
  keys: Row[];
  combos: Row[];
  settings: Row;
  kv: Row[];
  notMapped: Record<string, number>;
}): FridayLegacyState {
  const ownersOf = (rows: Row[]) =>
    Object.fromEntries(
      rows.filter((row) => row.owner).map((row) => [String(row.id), String(row.owner)])
    );
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.settings)) {
    if (!LEGACY_SETTING_KEYS.has(key) && !LEGACY_SETTING_PREFIX.test(key)) continue;
    if (SECRET_LOOKING.test(key)) {
      bump(input.notMapped, `settings.${key} (secret, not staged)`);
      continue;
    }
    settings[key] = value;
  }
  const preferences: Record<string, Record<string, unknown>> = {};
  for (const row of input.kv) {
    const scope = String(row.scope);
    if (!LEGACY_KV_SCOPES.has(scope)) continue;
    (preferences[scope] ??= {})[String(row.key)] = parseJson<unknown>(row.value, null);
  }
  return {
    owners: {
      providerConnections: ownersOf(input.connections),
      apiKeys: ownersOf(input.keys),
      combos: ownersOf(input.combos),
    },
    settings,
    preferences,
  };
}

const BCRYPT = /^\$2[aby]\$\d{2}\$/;
// Settings with the same meaning here. Everything else is reported, not copied.
const SETTINGS_KEPT = ["password", "requireLogin", "enableObservability"] as const;
// Per-connection transient state that must not outlive the process that produced it.
const TRANSIENT_PREFIXES = ["modelLock_", "modelLockMeta_"];

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function bump(counter: Record<string, number>, name: string, by = 1) {
  if (by > 0) counter[name] = (counter[name] ?? 0) + by;
}

/** Friday's `providerConnections` row → the legacy connection shape `runJsonMigration` reads. */
export function mapFridayConnection(row: Row, notMapped: Record<string, number>): Row {
  const data = parseJson<Row>(row.data, {});
  const connection: Row = {
    id: row.id,
    provider: row.provider,
    authType: row.authType ?? "oauth",
    name: row.name ?? null,
    email: row.email ?? null,
    priority: row.priority ?? 0,
    isActive: row.isActive === 0 ? false : true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  const known = new Set([
    "accessToken", "refreshToken", "expiresAt", "tokenExpiresAt", "scope", "projectId",
    "testStatus", "errorCode", "lastError", "lastErrorAt", "lastErrorType", "backoffLevel",
    "rateLimitedUntil", "lastTested", "apiKey", "idToken", "providerSpecificData",
    "expiresIn", "displayName", "defaultModel", "tokenType", "lastUsedAt", "lastRefreshAt",
  ]);
  for (const [key, value] of Object.entries(data)) {
    if (known.has(key)) connection[key] = value;
    else if (!TRANSIENT_PREFIXES.some((prefix) => key.startsWith(prefix)))
      bump(notMapped, `providerConnections.data.${key}`);
  }
  // The pool binding becomes a proxy assignment (see collectFridayProxyBindings); a pool id
  // left behind would point at a Friday id that no longer exists.
  const specific = connection.providerSpecificData;
  if (specific && typeof specific === "object" && !Array.isArray(specific)) {
    const { proxyPoolId: _dropped, ...rest } = specific as Row;
    connection.providerSpecificData = rest;
  }
  return connection;
}

// ─── Proxy pools ─────────────────────────────────────────────────────────────────────────────
// Friday keeps `proxyPools` (name, type http|vercel|cloudflare|deno, proxyUrl, noProxy,
// strictProxy, isActive) and binds a connection to one through
// `providerSpecificData.proxyPoolId` ("__none__" = explicitly no pool). This build keeps an
// outbound proxy registry with connection-scoped ("account") assignments.

const RELAY_POOL_TYPES = new Set(["vercel", "cloudflare", "deno"]);
const REGISTRY_URL_TYPES = new Set(["http", "https", "socks5"]);
const POOL_FIELDS_KEPT = new Set([
  "name", "type", "proxyUrl", "noProxy", "strictProxy", "isActive",
  // Runtime probe state, regenerated by the first test run.
  "testStatus", "lastTestedAt", "lastError",
]);
const NO_PROXY_POOL = "__none__";
const MAX_NOTE_CHARS = 900;

export interface MappedFridayProxy {
  /** Registry identity (host, port, username): pools sharing it collapse into one proxy. */
  key: string;
  payload: ProxyPayload;
  poolIds: string[];
  relay: boolean;
}

export interface FridayProxyMapping {
  proxies: MappedFridayProxy[];
  keyByPoolId: Map<string, string>;
}

const proxyKey = (host: string, port: number, username: string) =>
  `${host.toLowerCase()}\0${port}\0${username}`;

function parsePoolUrl(raw: string): URL | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return null;
  }
}

/** Friday's `proxyPools` rows → registry payloads. Nothing is logged: URLs can carry credentials. */
export function mapFridayProxyPools(
  rows: Row[],
  notMapped: Record<string, number>
): FridayProxyMapping {
  const byKey = new Map<string, MappedFridayProxy>();
  const keyByPoolId = new Map<string, string>();

  for (const row of rows) {
    const poolId = String(row.id ?? "");
    const data = parseJson<Row>(row.data, {});
    for (const field of Object.keys(data)) {
      if (!POOL_FIELDS_KEPT.has(field)) bump(notMapped, `proxyPools.data.${field}`);
    }
    const poolType = typeof data.type === "string" ? data.type.trim().toLowerCase() : "http";
    const relay = RELAY_POOL_TYPES.has(poolType);
    if (!relay && poolType !== "http") bump(notMapped, "proxyPools.unknownType (imported as http)");

    const url = parsePoolUrl(typeof data.proxyUrl === "string" ? data.proxyUrl : "");
    if (!poolId || !url || !url.hostname) {
      bump(notMapped, "proxyPools.unmappable (no usable proxyUrl)");
      continue;
    }
    const scheme = url.protocol.slice(0, -1).toLowerCase();
    let type: string;
    let port: number;
    let username = "";
    let password = "";
    if (relay) {
      // Registry relays are addressed by host; Friday relays are bare https endpoints.
      type = poolType;
      port = url.port ? Number(url.port) : 443;
    } else {
      type = scheme === "socks5h" ? "socks5" : scheme;
      if (!REGISTRY_URL_TYPES.has(type)) {
        bump(notMapped, `proxyPools.unmappable (unsupported scheme ${scheme})`);
        continue;
      }
      port = url.port ? Number(url.port) : type === "https" ? 443 : type === "socks5" ? 1080 : 80;
      username = url.username ? decodeUserinfo(url.username) : "";
      password = url.password ? decodeUserinfo(url.password) : "";
    }

    const noProxy = typeof data.noProxy === "string" ? data.noProxy.trim() : "";
    if (noProxy) bump(notMapped, "proxyPools.noProxy (bypass list is not enforced)");
    if (data.strictProxy === true) bump(notMapped, "proxyPools.strictProxy");

    const key = proxyKey(url.hostname, port, username);
    keyByPoolId.set(poolId, key);
    const existing = byKey.get(key);
    if (existing) {
      existing.poolIds.push(poolId);
      bump(notMapped, "proxyPools.mergedDuplicate");
      continue;
    }
    const name = (typeof data.name === "string" && data.name.trim()) || `${url.hostname}:${port}`;
    byKey.set(key, {
      key,
      poolIds: [poolId],
      relay,
      payload: {
        name,
        type,
        host: url.hostname,
        port,
        username,
        password,
        notes: relay
          ? null
          : `Imported from a Friday proxy pool${noProxy ? `. No-proxy list: ${noProxy}` : ""}`.slice(
              0,
              MAX_NOTE_CHARS
            ),
        status: row.isActive === 0 ? "inactive" : "active",
        source: relay ? `${type}-relay` : "manual",
      },
    });
  }
  return { proxies: [...byKey.values()], keyByPoolId };
}

/** Which imported connection was bound to which Friday pool ("__none__" and blanks are no binding). */
export function collectFridayProxyBindings(
  rawConnections: Row[]
): Array<{ connectionId: string; poolId: string }> {
  const bindings: Array<{ connectionId: string; poolId: string }> = [];
  for (const row of rawConnections) {
    const specific = parseJson<Row>(row.data, {}).providerSpecificData;
    const poolId =
      specific && typeof specific === "object"
        ? (specific as Row).proxyPoolId
        : undefined;
    if (typeof poolId !== "string" || !poolId.trim() || poolId === NO_PROXY_POOL) continue;
    bindings.push({ connectionId: String(row.id), poolId: poolId.trim() });
  }
  return bindings;
}

interface ProxyApplyResult {
  proxies: number;
  assignments: number;
  relaysNeedingAuth: number;
  inactiveBound: number;
}

/**
 * Writes the mapped pools to the registry and binds connections to them. Re-running never
 * duplicates a proxy (matched on host + port + username, the registry's own identity, so a
 * proxy the operator already added is reused untouched) and never replaces a connection's
 * existing proxy assignment. Pass `dryRun` to only count what would happen.
 */
async function applyFridayProxies(
  mapping: FridayProxyMapping,
  bindings: Array<{ connectionId: string; poolId: string }>,
  notMapped: Record<string, number>,
  dryRun: boolean
): Promise<ProxyApplyResult> {
  const result: ProxyApplyResult = {
    proxies: mapping.proxies.length,
    assignments: 0,
    relaysNeedingAuth: mapping.proxies.filter((proxy) => proxy.relay).length,
    inactiveBound: 0,
  };
  const idByKey = new Map<string, string>();
  const assigned = new Set<string>();
  if (!dryRun) {
    const { items } = await listProxies({ includeSecrets: true });
    for (const proxy of items) {
      idByKey.set(proxyKey(proxy.host, proxy.port, proxy.username), proxy.id);
    }
    for (const assignment of await getProxyAssignments({ scope: "account" })) {
      if (assignment.scopeId) assigned.add(assignment.scopeId);
    }
    for (const proxy of mapping.proxies) {
      if (idByKey.has(proxy.key)) continue;
      const created = await createProxy(proxy.payload);
      if (created) idByKey.set(proxy.key, created.id);
    }
  }
  const inactiveKeys = new Set(
    mapping.proxies.filter((proxy) => proxy.payload.status === "inactive").map((proxy) => proxy.key)
  );
  for (const binding of bindings) {
    const key = mapping.keyByPoolId.get(binding.poolId);
    if (!key) {
      bump(notMapped, "providerConnections.proxyPoolId (pool missing or unmappable)");
      continue;
    }
    if (dryRun) {
      result.assignments++;
    } else {
      const proxyId = idByKey.get(key);
      if (!proxyId || assigned.has(binding.connectionId)) continue;
      await assignProxyToScope("account", binding.connectionId, proxyId);
      assigned.add(binding.connectionId);
      result.assignments++;
    }
    if (inactiveKeys.has(key)) result.inactiveBound++;
  }
  return result;
}

interface MappedKey {
  id: string;
  name: string;
  key: string;
  machineId: string | null;
  createdAt: string;
  isActive: boolean;
  allowedConnections: string[];
  modelAccessMode: "all" | "restricted";
  allowedModels: string[];
  blockedModels: string[];
  scopes: string[];
  tags: string[] | undefined;
  quota: ReturnType<typeof snapshotInitialKeyQuotaLimits>;
  modelIdFormat: "prefixed" | "flat";
}

/** Friday's `apiKeys` row → what this schema stores (tags, quotas and id format live elsewhere). */
export function mapFridayKey(row: Row): MappedKey {
  const access = parseJson<{ mode?: string; patterns?: unknown }>(row.modelAccess, {});
  const patterns = Array.isArray(access.patterns) ? access.patterns.map(String) : [];
  const limits = parseJson<{ rpm?: number; tokensPerDay?: number; usdPerMonth?: number }>(
    row.limits,
    {}
  );
  const format = row.modelIdFormat === "flat" ? "flat" : "prefixed";
  return {
    id: String(row.id),
    name: String(row.name ?? "Imported key"),
    key: String(row.key),
    machineId: (row.machineId as string | null) ?? null,
    createdAt: String(row.createdAt ?? new Date().toISOString()),
    isActive: row.isActive !== 0,
    allowedConnections: parseJson<string[]>(row.allowedConnectionIds, []),
    modelAccessMode: access.mode === "allow" && patterns.length > 0 ? "restricted" : "all",
    allowedModels: access.mode === "allow" ? patterns : [],
    blockedModels: access.mode === "deny" ? patterns : [],
    scopes: row.role === "admin" ? ["manage"] : [],
    tags: snapshotApiKeyTags(parseJson<string[]>(row.tags, [])),
    quota:
      limits.rpm || limits.tokensPerDay || limits.usdPerMonth
        ? snapshotInitialKeyQuotaLimits({
            rpmLimit: limits.rpm ?? null,
            dailyTokensLimit: limits.tokensPerDay ?? null,
            monthlyAmountUsd: limits.usdPerMonth ?? null,
          })
        : undefined,
    modelIdFormat: validateApiKeyModelIdFormat(format),
  };
}

/** Friday's `usageHistory` row → this schema's row, joining the raw key to its imported id. */
export function mapFridayUsage(row: Row, keyIdByRawKey: Map<string, string>): Row {
  const tokens = parseJson<Record<string, number>>(row.tokens, {});
  const keyId = typeof row.apiKey === "string" ? (keyIdByRawKey.get(row.apiKey) ?? null) : null;
  const status = String(row.status ?? "");
  return {
    // Let the target assign ids: Friday's ids would replace rows this install already logged.
    id: null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    connection_id: row.connectionId ?? null,
    api_key_id: keyId,
    tokens_input: tokens.prompt_tokens ?? tokens.input_tokens ?? row.promptTokens ?? 0,
    tokens_output: tokens.completion_tokens ?? tokens.output_tokens ?? row.completionTokens ?? 0,
    tokens_cache_read: tokens.cached_tokens ?? 0,
    tokens_cache_creation: tokens.cache_creation_input_tokens ?? 0,
    tokens_reasoning: tokens.reasoning_tokens ?? 0,
    status: status || null,
    success: status === "ok" || status === "success" ? 1 : 0,
    timestamp: row.timestamp,
  };
}

interface CustomModel {
  id: string;
  name: string;
  source: string;
  apiFormat: "chat-completions";
  supportedEndpoints: string[];
}

/**
 * Friday's `kv` scope `customModels` (one row per model, keyed `alias|id|type`) → this build's
 * per-provider lists. Only chat ("llm") models map; other kinds are reported.
 */
export function mapFridayCustomModels(
  rows: Row[],
  notMapped: Record<string, number>
): Record<string, CustomModel[]> {
  const byProvider: Record<string, CustomModel[]> = {};
  for (const row of rows) {
    const value = parseJson<{ providerAlias?: string; id?: string; type?: string; name?: string }>(
      row.value,
      {}
    );
    if (!value.providerAlias || !value.id) continue;
    if ((value.type ?? "llm") !== "llm") {
      bump(notMapped, `customModels.${value.type}`);
      continue;
    }
    const provider = resolveProviderAlias(value.providerAlias) ?? value.providerAlias;
    const list = (byProvider[provider] ??= []);
    if (!list.some((model) => model.id === value.id)) {
      list.push({
        id: value.id,
        name: value.name || value.id,
        source: "imported",
        apiFormat: "chat-completions",
        supportedEndpoints: ["chat"],
      });
    }
  }
  return byProvider;
}

function all(db: SqliteAdapter, table: string): Row[] {
  try {
    return db.prepare(`SELECT * FROM ${table}`).all() as Row[];
  } catch {
    return []; // an older Friday schema may lack a table
  }
}

function copyWithSidecars(source: string, targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  const copy = path.join(targetDir, FRIDAY_DATABASE_FILE);
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, copy + suffix);
  }
  return copy;
}

/** True when there is Friday data to bring over and nothing has been imported yet. */
export function fridayImportPending(dataDir: string): boolean {
  if (!fs.existsSync(path.join(dataDir, FRIDAY_DATABASE_FILE))) return false;
  return !fs.existsSync(path.join(dataDir, FRIDAY_IMPORT_MARKER));
}

export interface FridayImportOptions {
  dataDir: string;
  dryRun?: boolean;
  /** Run again after a completed import; usage is skipped so it is not duplicated. */
  force?: boolean;
  now?: () => Date;
}

export async function importFridayData(options: FridayImportOptions): Promise<FridayImportReport> {
  const { dataDir, dryRun = false, force = false } = options;
  const source = path.join(dataDir, FRIDAY_DATABASE_FILE);
  if (!fs.existsSync(source)) throw new Error(`No Friday database at ${source}`);
  if (!force && fs.existsSync(path.join(dataDir, FRIDAY_IMPORT_MARKER)))
    throw new Error("Friday data was already imported; pass force to import again");

  const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(dataDir, "backups", `friday-${stamp}`);
  const copy = copyWithSidecars(source, backupDir);
  const reader = tryOpenSync(copy);
  if (!reader) throw new Error("No SQLite driver is available to read the Friday database");

  const notMapped: Record<string, number> = {};
  try {
    const connections = all(reader, "providerConnections").map((row) =>
      mapFridayConnection(row, notMapped)
    );
    const rawConnections = all(reader, "providerConnections");
    const rawKeys = all(reader, "apiKeys");
    const keyRows = rawKeys.map((row) => mapFridayKey(row));
    const allCombos = all(reader, "combos");
    const combos = allCombos.filter((row) => {
      if (row.kind) bump(notMapped, `combos.kind.${String(row.kind)}`);
      try {
        validateComboInvariant(
          normalizeComboRecord({
            id: row.id,
            name: row.name,
            models: parseJson<string[]>(row.models, []),
            strategy: normalizeRoutingStrategy(undefined),
            sortOrder: 1,
          })
        );
        return true;
      } catch {
        bump(notMapped, "combos.invalid");
        return false;
      }
    });
    const settingsRow = all(reader, "settings")[0];
    const settings = parseJson<Row>(settingsRow?.data, {});
    const kv = all(reader, "kv");
    const usage = force ? [] : all(reader, "usageHistory");

    for (const table of ["providerNodes", "usageSinks", "usageDeliveries"])
      bump(notMapped, table, all(reader, table).length);
    const proxyMapping = mapFridayProxyPools(all(reader, "proxyPools"), notMapped);
    const proxyBindings = collectFridayProxyBindings(rawConnections);
    for (const row of kv) {
      const scope = String(row.scope);
      if (!["modelAliases", "pricing", "mitmAlias", "customModels"].includes(scope) && !LEGACY_KV_SCOPES.has(scope))
        bump(notMapped, `kv.${scope}`);
    }
    const staging = collectFridayLegacy({
      connections: rawConnections,
      keys: rawKeys,
      combos: allCombos,
      settings,
      kv,
      notMapped,
    });
    for (const key of Object.keys(settings)) {
      const staged = LEGACY_SETTING_KEYS.has(key) || LEGACY_SETTING_PREFIX.test(key);
      if (!(SETTINGS_KEPT as readonly string[]).includes(key) && !staged)
        bump(notMapped, `settings.${key}`);
    }

    const customModels = mapFridayCustomModels(
      kv.filter((row) => row.scope === "customModels"),
      notMapped
    );
    const keyIdByRawKey = new Map(keyRows.map((key) => [key.key, key.id]));
    const kvOf = (scope: string) =>
      Object.fromEntries(
        kv
          .filter((row) => row.scope === scope)
          .map((row) => [String(row.key), parseJson<unknown>(row.value, null)])
      );

    const keptSettings: Row = {};
    for (const key of SETTINGS_KEPT) {
      if (!(key in settings)) continue;
      // Only a real bcrypt hash carries over; a plaintext value would be a new secret in the clear.
      if (key === "password" && !BCRYPT.test(String(settings.password))) continue;
      keptSettings[key] = settings[key];
    }

    // Projection first (it also does the notMapped accounting); a real run replaces the counts
    // below with what was actually written.
    const proxyPlan = await applyFridayProxies(proxyMapping, proxyBindings, notMapped, true);

    const report: FridayImportReport = {
      source,
      backup: dryRun ? null : backupDir,
      dryRun,
      imported: {
        connections: connections.length,
        apiKeys: keyRows.length,
        combos: combos.length,
        usageHistory: usage.length,
        settings: Object.keys(keptSettings).length,
        modelAliases: Object.keys(kvOf("modelAliases")).length,
        customModels: Object.values(customModels).reduce((sum, list) => sum + list.length, 0),
        proxies: proxyPlan.proxies,
        proxyAssignments: proxyPlan.assignments,
        legacyStaged:
          Object.keys(staging.owners.providerConnections).length +
          Object.keys(staging.owners.apiKeys).length +
          Object.keys(staging.owners.combos).length +
          Object.keys(staging.settings).length +
          Object.values(staging.preferences).reduce((sum, map) => sum + Object.keys(map).length, 0),
      },
      warnings: [
        ...(keyRows.some((key) => key.scopes.includes("manage"))
          ? [
              `${keyRows.filter((key) => key.scopes.includes("manage")).length} Friday admin key(s) ` +
                "were imported with the management scope (this build's admin role), which is broader " +
                "than Friday's MCP-only admin key; review them in Endpoint & Keys.",
            ]
          : []),
        ...(proxyPlan.relaysNeedingAuth > 0
          ? [
              `${proxyPlan.relaysNeedingAuth} Friday relay pool(s) were imported as relay proxies ` +
                "without relay authentication (Friday relays had none); they cannot carry traffic " +
                "until relay auth is set or the relay is redeployed in Proxies.",
            ]
          : []),
        ...(proxyPlan.inactiveBound > 0
          ? [
              `${proxyPlan.inactiveBound} connection(s) are bound to an inactive Friday proxy pool. ` +
                "Friday sent their traffic direct; this build fails closed for an inactive assigned " +
                "proxy, so reactivate the proxy or remove the assignment.",
            ]
          : []),
      ],
      notMapped,
      providers: [...new Set(connections.map((c) => String(c.provider)))].sort(),
    };
    if (dryRun) {
      fs.rmSync(backupDir, { recursive: true, force: true });
      return report;
    }

    const legacy: LegacyJsonData = {
      providerConnections: connections,
      combos: combos.map((row) => ({
        id: row.id,
        name: row.name,
        models: parseJson<string[]>(row.models, []),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      settings: keptSettings,
      modelAliases: kvOf("modelAliases"),
      pricing: kvOf("pricing"),
      mitmAlias: kvOf("mitmAlias"),
      usageHistory: usage.map((row) => mapFridayUsage(row, keyIdByRawKey)),
    };
    const target = getDbInstance() as unknown as SqliteAdapter;
    runJsonMigration(target, legacy);
    await insertKeys(target, keyRows);
    mergeCustomModels(target, customModels);
    stageLegacy(target, staging);
    const applied = await applyFridayProxies(proxyMapping, proxyBindings, {}, false);
    report.imported.proxies = applied.proxies;
    report.imported.proxyAssignments = applied.assignments;

    fs.writeFileSync(
      path.join(dataDir, FRIDAY_IMPORT_MARKER),
      JSON.stringify({ importedAt: new Date().toISOString(), backup: backupDir }, null, 2)
    );
    fs.writeFileSync(
      path.join(dataDir, FRIDAY_IMPORT_REPORT),
      JSON.stringify(report, null, 2) + "\n"
    );
    return report;
  } finally {
    reader.close();
  }
}

async function insertKeys(db: SqliteAdapter, keys: MappedKey[]): Promise<void> {
  // Several api_keys columns are added lazily; a fresh database does not have them yet.
  ensureApiKeysSchema(db as unknown as Parameters<typeof ensureApiKeysSchema>[0]);
  const hashes = await Promise.all(keys.map((key) => hashKey(key.key)));
  const insert = db.prepare(
    `INSERT OR REPLACE INTO api_keys (
       id, name, key, machine_id, model_access_mode, allowed_models, blocked_models,
       allowed_combos, allowed_connections, no_log, is_active, created_at,
       key_prefix, key_hash, scopes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
  );
  const clearExtras = db.prepare(
    "DELETE FROM key_value WHERE namespace IN ('api_key_tags', 'api_key_id_format') AND key = ?"
  );
  db.transaction(() => {
    keys.forEach((key, index) => {
      clearExtras.run(key.id);
      insert.run(
        key.id,
        key.name,
        key.key,
        key.machineId,
        key.modelAccessMode,
        JSON.stringify(key.allowedModels),
        JSON.stringify(key.blockedModels),
        JSON.stringify([ALL_COMBOS_ACCESS_RULE]),
        JSON.stringify(key.allowedConnections),
        key.isActive ? 1 : 0,
        key.createdAt,
        key.key.slice(0, 12),
        hashes[index],
        JSON.stringify(key.scopes)
      );
      if (key.quota) insertInitialKeyQuotaLimitsInTransaction(key.id, key.quota);
      if (key.tags) insertInitialApiKeyTagsInTransaction(key.id, key.tags);
      insertInitialApiKeyModelIdFormatInTransaction(key.id, key.modelIdFormat);
    });
  })();
}

/** Adds imported custom models beside any the provider already has, never replacing one. */
function mergeCustomModels(db: SqliteAdapter, byProvider: Record<string, CustomModel[]>): void {
  const read = db.prepare("SELECT value FROM key_value WHERE namespace = 'customModels' AND key = ?");
  const write = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('customModels', ?, ?)"
  );
  db.transaction(() => {
    for (const [provider, models] of Object.entries(byProvider)) {
      const row = read.get(provider) as { value?: string } | undefined;
      const existing = parseJson<{ id?: string }[]>(row?.value, []);
      const merged = [...existing];
      for (const model of models) if (!existing.some((entry) => entry.id === model.id)) merged.push(model);
      write.run(provider, JSON.stringify(merged));
    }
  })();
}

/** Writes Friday's user scoping to `key_value` (namespace friday_legacy) for the tenancy migration. */
function stageLegacy(db: SqliteAdapter, legacy: FridayLegacyState): void {
  const write = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)"
  );
  db.transaction(() => {
    write.run(FRIDAY_LEGACY_NAMESPACE, "owners", JSON.stringify(legacy.owners));
    write.run(FRIDAY_LEGACY_NAMESPACE, "settings", JSON.stringify(legacy.settings));
    write.run(FRIDAY_LEGACY_NAMESPACE, "preferences", JSON.stringify(legacy.preferences));
  })();
}
