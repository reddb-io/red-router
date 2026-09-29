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
  };
  /** Friday data the importer read but has no mapping for yet, by name → count. */
  notMapped: Record<string, number>;
  providers: string[];
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
  if (row.owner) bump(notMapped, "providerConnections.owner");
  return connection;
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
export function mapFridayKey(row: Row, notMapped: Record<string, number>): MappedKey {
  const access = parseJson<{ mode?: string; patterns?: unknown }>(row.modelAccess, {});
  const patterns = Array.isArray(access.patterns) ? access.patterns.map(String) : [];
  const limits = parseJson<{ rpm?: number; tokensPerDay?: number; usdPerMonth?: number }>(
    row.limits,
    {}
  );
  const format = row.modelIdFormat === "flat" ? "flat" : "prefixed";
  if (row.owner) bump(notMapped, "apiKeys.owner");
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
    const keyRows = all(reader, "apiKeys").map((row) => mapFridayKey(row, notMapped));
    const combos = all(reader, "combos").filter((row) => {
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

    for (const table of ["providerNodes", "proxyPools", "usageSinks", "usageDeliveries"])
      bump(notMapped, table, all(reader, table).length);
    for (const row of kv) {
      const scope = String(row.scope);
      if (!["modelAliases", "pricing", "mitmAlias", "customModels"].includes(scope))
        bump(notMapped, `kv.${scope}`);
    }
    for (const key of Object.keys(settings))
      if (!(SETTINGS_KEPT as readonly string[]).includes(key)) bump(notMapped, `settings.${key}`);

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
      },
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
