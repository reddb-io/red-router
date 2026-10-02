/**
 * modelsDevSync.ts — Fetch model specs, pricing, and capabilities from models.dev
 *
 * models.dev (https://github.com/anomalyco/models.dev) is an open-source database
 * of AI model specifications maintained by the SST/OpenCode team (MIT license).
 *
 * API: https://models.dev/api.json?type=all
 * - Data: pricing, capabilities, limits, modalities, metadata
 *
 * Resolution order (highest → lowest):
 *   1. User overrides (`pricing` namespace)
 *   2. models.dev sync (`models_dev_pricing` namespace)
 *   3. LiteLLM sync (`pricing_synced` namespace)
 *   4. Hardcoded defaults (`pricing.ts`)
 *
 * Settings UI (`modelsDevSyncEnabled`) controls the periodic sync by default.
 * `MODELS_DEV_SYNC_ENABLED=0|false|off|no` is a hard kill switch: it wins over
 * the DB setting so an operator can recover a wedged process (dashboard /
 * /healthz frozen on the same event loop — #10052) without the UI. Unset =
 * honor settings. `1|true|on|yes` forces sync on even if the setting is off.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  commitModelsDevSnapshot,
  clearModelsDevSnapshot,
  readModelsDevSnapshotData,
  readModelsDevSnapshotMetadata,
  type ModelsDevSnapshotMetadata,
} from "./db/modelsDevSnapshot";
import { getDbInstance } from "./db/core";
import { invalidateDbCache, getModelCatalogCacheVersion } from "./db/readCache";
import { backupDbFile } from "./db/backup";
import { getBundledModelsDevCapability } from "./catalog/modelsDevSeed";

import {
  transformModelsDevToPricing,
  transformModelsDevToCapabilities,
  MODELS_DEV_SOURCE_URL,
  MODELS_DEV_TRANSFORM_VERSION,
} from "./modelsDevSync/transform";
import type {
  PricingModels,
  PricingByProvider,
  ModelCapabilityEntry,
  CapabilitiesByProvider,
  ModelsDevData,
} from "./modelsDevSync/transform";

// Re-export the pure transform layer (moved to ./modelsDevSync/transform)
// so this module's public API is unchanged.
export {
  mapProviderId,
  transformModelsDevToPricing,
  transformModelsDevToCapabilities,
} from "./modelsDevSync/transform";
export type {
  ModelCapabilityEntry,
  CapabilitiesByProvider,
  PricingByProvider,
} from "./modelsDevSync/transform";

// ─── Types ───────────────────────────────────────────────

interface SyncStatus {
  enabled: boolean;
  lastSync: string | null;
  lastSyncModelCount: number;
  lastSyncCapabilityCount: number;
  nextSync: string | null;
  intervalMs: number;
  snapshot: ModelsDevSnapshotMetadata | null;
  lastCheck: string | null;
}

interface SyncResult {
  success: boolean;
  modelCount: number;
  providerCount: number;
  capabilityCount: number;
  dryRun: boolean;
  data?: { pricing: PricingByProvider; capabilities: CapabilitiesByProvider };
  error?: string;
}

// ─── Configuration ───────────────────────────────────────

const MODELS_DEV_API_URL = MODELS_DEV_SOURCE_URL;

const parsedInterval = parseInt(process.env.MODELS_DEV_SYNC_INTERVAL || "86400", 10);
const SYNC_INTERVAL_MS =
  Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval * 1000 : 86400 * 1000;

/** Parse MODELS_DEV_SYNC_ENABLED. Invalid / empty → unset (honor DB settings). */
export function readModelsDevSyncEnvFlag(
  value: string | undefined = process.env.MODELS_DEV_SYNC_ENABLED
): "true" | "false" | "unset" {
  if (value == null) return "unset";
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return "unset";
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return "true";
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return "false";
  }
  return "unset";
}

export function isModelsDevSyncEnvDisabled(): boolean {
  return readModelsDevSyncEnvFlag() === "false";
}

export function isModelsDevSyncEnvForcedOn(): boolean {
  return readModelsDevSyncEnvFlag() === "true";
}

// ─── Periodic sync state ─────────────────────────────────

let syncTimer: ReturnType<typeof setInterval> | null = null;
type SyncOptions = {
  dryRun?: boolean;
  syncCapabilities?: boolean;
  maxRetries?: number;
  signal?: AbortSignal;
  force?: boolean;
};
interface SharedModelsDevSync {
  key: string;
  controller: AbortController;
  promise: Promise<SyncResult>;
  subscribers: Set<symbol>;
  completed: boolean;
}
let sharedSync: SharedModelsDevSync | null = null;
let activePeriodicSyncToken: { stopped: boolean; controller: AbortController } | null = null;
let lastSyncTime: string | null = null;
let lastSyncModelCount = 0;
let lastSyncCapabilityCount = 0;
let activeSyncIntervalMs = SYNC_INTERVAL_MS;
let cacheTime = 0;
interface PublicModelsDevSnapshot {
  data: ModelsDevData;
  fetchedAt: string;
  checkedAt: string;
  sha256: string;
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
}
let cachedPublicSnapshot: PublicModelsDevSnapshot | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
let cachedCapabilities: CapabilitiesByProvider | null = null;
let cachedCapabilitiesLoadedAll = false;
let cachedCapabilitiesDb: ReturnType<typeof getDbInstance> | null = null;
let cachedCapabilitiesVersion = -1;
let overlayCompatibilityDb: ReturnType<typeof getDbInstance> | null = null;
let overlayCompatibilityVersion = -1;
let overlayCompatible = false;
let capabilityOverlayCompatible = false;
const MODELS_DEV_ABORT_ERROR = "AbortError";

function createAbortError(): Error {
  const error = new Error("models.dev sync aborted");
  error.name = MODELS_DEV_ABORT_ERROR;
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === MODELS_DEV_ABORT_ERROR;
}

function createAbortedSyncResult(dryRun: boolean): SyncResult {
  return {
    success: false,
    modelCount: 0,
    providerCount: 0,
    capabilityCount: 0,
    dryRun,
    error: "aborted",
  };
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw createAbortError();
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      reject(createAbortError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ─── Core: Fetch ─────────────────────────────────────────

const reasoningOptionSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("toggle") }),
    z.object({ type: z.literal("effort"), values: z.array(z.string().min(1).nullable()) }),
    z.object({
      type: z.literal("budget_tokens"),
      min: z.number().min(-1).optional(),
      max: z.number().nonnegative().optional(),
    }),
  ])
  .refine(
    (option) =>
      option.type !== "budget_tokens" ||
      option.min === undefined ||
      option.max === undefined ||
      option.min <= option.max,
    "Invalid reasoning budget range"
  );

/** Keep public descriptors only: API/body/env/header fields never enter this cache. */
function parseModelsDevPublicData(input: unknown): ModelsDevData {
  try {
    const data = z
      .record(
        z.string(),
        z
          .object({
            id: z.string().min(1),
            name: z.string().optional(),
            models: z.record(
              z.string(),
              z
                .object({
                  id: z.string().min(1),
                  name: z.string(),
                  family: z.string().optional(),
                  type: z.string().min(1).optional(),
                  canonical_model_id: z.string().min(1).optional(),
                  reasoning_options: z.array(reasoningOptionSchema).optional(),
                  attachment: z.boolean().optional(),
                  reasoning: z.boolean().optional(),
                  tool_call: z.boolean().optional(),
                  structured_output: z.boolean().optional(),
                  temperature: z.boolean().optional(),
                  knowledge: z.string().optional(),
                  release_date: z.string().optional(),
                  last_updated: z.string().optional(),
                  open_weights: z.boolean().optional(),
                  status: z.string().optional(),
                  cost: z
                    .object({
                      input: z.number().nonnegative().optional(),
                      output: z.number().nonnegative().optional(),
                      reasoning: z.number().nonnegative().optional(),
                      cache_read: z.number().nonnegative().optional(),
                      cache_write: z.number().nonnegative().optional(),
                      input_audio: z.number().nonnegative().optional(),
                      output_audio: z.number().nonnegative().optional(),
                    })
                    .strip()
                    .optional(),
                  limit: z
                    .object({
                      context: z.number().nonnegative().optional(),
                      input: z.number().nonnegative().optional(),
                      output: z.number().nonnegative().optional(),
                    })
                    .strip()
                    .optional(),
                  modalities: z
                    .object({
                      input: z.array(z.string()).optional(),
                      output: z.array(z.string()).optional(),
                    })
                    .strip()
                    .optional(),
                  interleaved: z
                    .union([z.boolean(), z.object({ field: z.string().optional() }).strip()])
                    .optional(),
                })
                .strip()
            ),
          })
          .strip()
      )
      .parse(input);
    if (!Object.values(data).some((provider) => Object.keys(provider.models).length))
      throw new Error("Empty snapshot");
    return data;
  } catch {
    throw new Error("models.dev returned an invalid or empty catalog snapshot");
  }
}

function loadPersistedPublicSnapshot(): PublicModelsDevSnapshot | null {
  const metadata = readModelsDevSnapshotMetadata();
  if (!metadata || metadata.source !== MODELS_DEV_API_URL) return null;
  const stored = readModelsDevSnapshotData();
  if (stored === null) return null;
  try {
    const data = parseModelsDevPublicData(stored);
    const sha256 = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    if (sha256 !== metadata.sha256) return null;
    return {
      data,
      fetchedAt: metadata.fetchedAt,
      checkedAt: metadata.checkedAt || metadata.fetchedAt,
      sha256,
      etag: metadata.etag || null,
      lastModified: metadata.lastModified || null,
      notModified: false,
    };
  } catch {
    return null;
  }
}

async function fetchModelsDevPublicSnapshot(
  signal?: AbortSignal,
  options: { force?: boolean; timeoutMs?: number } = {}
): Promise<PublicModelsDevSnapshot> {
  signal?.throwIfAborted();
  if (!options.force && cachedPublicSnapshot && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedPublicSnapshot;
  }

  const previous = cachedPublicSnapshot || loadPersistedPublicSnapshot();
  const headers = new Headers();
  if (previous?.etag) headers.set("If-None-Match", previous.etag);
  if (previous?.lastModified) headers.set("If-Modified-Since", previous.lastModified);
  const response = await fetch(MODELS_DEV_API_URL, {
    headers,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 30000)])
      : AbortSignal.timeout(options.timeoutMs ?? 30000),
  });
  const checkedAt = new Date().toISOString();
  let snapshot: PublicModelsDevSnapshot;
  if (response.status === 304) {
    if (!previous) throw new Error("models.dev returned 304 without a usable public snapshot");
    snapshot = {
      ...previous,
      checkedAt,
      etag: response.headers.get("etag") || previous.etag,
      lastModified: response.headers.get("last-modified") || previous.lastModified,
      notModified: true,
    };
  } else {
    if (!response.ok) {
      throw new Error(`models.dev fetch failed [${response.status}]: ${response.statusText}`);
    }
    let data: ModelsDevData;
    try {
      data = parseModelsDevPublicData(await response.json());
    } catch {
      throw new Error("models.dev returned an invalid or empty catalog snapshot");
    }
    snapshot = {
      data,
      fetchedAt: checkedAt,
      checkedAt,
      sha256: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      notModified: false,
    };
  }
  signal?.throwIfAborted();
  cachedPublicSnapshot = snapshot;
  cacheTime = Date.now();
  return snapshot;
}

/** Fetch public metadata; force bypasses TTL while retaining conditional HTTP validation. */
export async function fetchModelsDev(
  signal?: AbortSignal,
  options: { force?: boolean; timeoutMs?: number } = {}
): Promise<ModelsDevData> {
  return (await fetchModelsDevPublicSnapshot(signal, options)).data;
}

// ─── DB: models.dev pricing namespace ────────────────────

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Old transform output is quarantined on read; user/discovery namespaces stay intact. */
function isCurrentModelsDevOverlay(requireCapabilities = false): boolean {
  const db = getDbInstance();
  const version = getModelCatalogCacheVersion();
  if (overlayCompatibilityDb !== db || overlayCompatibilityVersion !== version) {
    const metadata = readModelsDevSnapshotMetadata();
    overlayCompatible =
      metadata?.source === MODELS_DEV_API_URL &&
      metadata.transformVersion === MODELS_DEV_TRANSFORM_VERSION;
    capabilityOverlayCompatible = overlayCompatible && metadata?.capabilitiesSynced === true;
    overlayCompatibilityDb = db;
    overlayCompatibilityVersion = version;
  }
  return requireCapabilities ? capabilityOverlayCompatible : overlayCompatible;
}

function filterCurrentCapabilityRows(rows: unknown[]): unknown[] {
  if (isCurrentModelsDevOverlay(true)) return rows;
  return rows.filter((row) => toRecord(row).capability_source !== "models-dev");
}

function mapCapabilityRecord(record: Record<string, unknown>): ModelCapabilityEntry {
  return {
    tool_call: record.tool_call === 1 ? true : record.tool_call === 0 ? false : null,
    reasoning: record.reasoning === 1 ? true : record.reasoning === 0 ? false : null,
    attachment: record.attachment === 1 ? true : record.attachment === 0 ? false : null,
    structured_output:
      record.structured_output === 1 ? true : record.structured_output === 0 ? false : null,
    temperature: record.temperature === 1 ? true : record.temperature === 0 ? false : null,
    modalities_input: typeof record.modalities_input === "string" ? record.modalities_input : "[]",
    modalities_output:
      typeof record.modalities_output === "string" ? record.modalities_output : "[]",
    knowledge_cutoff: typeof record.knowledge_cutoff === "string" ? record.knowledge_cutoff : null,
    release_date: typeof record.release_date === "string" ? record.release_date : null,
    last_updated: typeof record.last_updated === "string" ? record.last_updated : null,
    status: typeof record.status === "string" ? record.status : null,
    family: typeof record.family === "string" ? record.family : null,
    open_weights: record.open_weights === 1 ? true : record.open_weights === 0 ? false : null,
    limit_context: typeof record.limit_context === "number" ? record.limit_context : null,
    limit_input: typeof record.limit_input === "number" ? record.limit_input : null,
    limit_output: typeof record.limit_output === "number" ? record.limit_output : null,
    interleaved_field:
      typeof record.interleaved_field === "string" ? record.interleaved_field : null,
    model_type: typeof record.model_type === "string" ? record.model_type : null,
    canonical_model_id:
      typeof record.canonical_model_id === "string" ? record.canonical_model_id : null,
    reasoning_options:
      typeof record.reasoning_options === "string" ? record.reasoning_options : null,
    source_provider: typeof record.source_provider === "string" ? record.source_provider : null,
    native_model_id: typeof record.native_model_id === "string" ? record.native_model_id : null,
    metadata_source:
      typeof record.capability_source === "string" ? record.capability_source : "legacy",
  };
}

// #8697: getModelsDevPricing() re-ran the SELECT + JSON.parse of ~180 blobs on
// every call — called once per catalog model (up to ~6091x) instead of once per
// request, freezing the whole server 41-54s on a cold /v1/models rebuild.
// Memoized here, invalidated via the same modelCatalogCacheVersion signal
// save/clearModelsDevPricing already bump through invalidateDbCache("pricing") —
// reusing the existing pattern (getCachedRawProviderConnections et al. in
// db/readCache.ts) instead of introducing a new invalidation mechanism.
let pricingMemo: PricingByProvider | null = null;
let pricingMemoVersion = -1; // -1: never equals a real cacheVersion (starts at 0), guarantees a miss on the first call

/**
 * Read synced pricing from `models_dev_pricing` namespace.
 * Results are memoized until `saveModelsDevPricing` / `clearModelsDevPricing`.
 */
export function getModelsDevPricing(): PricingByProvider {
  // Kill switch: skip the SQL + JSON.parse scan entirely so a leftover
  // models_dev_pricing namespace cannot pin the event loop (#9685 / #10052).
  if (isModelsDevSyncEnvDisabled()) {
    return {};
  }
  if (!isCurrentModelsDevOverlay()) return {};

  const currentVersion = getModelCatalogCacheVersion();
  if (pricingMemo !== null && pricingMemoVersion === currentVersion) {
    return pricingMemo;
  }

  const db = getDbInstance();
  const rows = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = 'models_dev_pricing'")
    .all();
  const synced: PricingByProvider = {};
  for (const row of rows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    try {
      synced[key] = JSON.parse(rawValue) as PricingModels;
    } catch {
      console.warn(`[MODELS_DEV] Corrupted pricing data for provider "${key}", skipping`);
    }
  }
  pricingMemo = synced;
  pricingMemoVersion = currentVersion;
  return synced;
}

/**
 * Save synced pricing to `models_dev_pricing` namespace (full replace).
 */
export function saveModelsDevPricing(data: PricingByProvider, notify = true): void {
  const db = getDbInstance();
  const del = db.prepare("DELETE FROM key_value WHERE namespace = 'models_dev_pricing'");
  const insert = db.prepare(
    "INSERT INTO key_value (namespace, key, value) VALUES ('models_dev_pricing', ?, ?)"
  );
  const tx = db.transaction(() => {
    del.run();
    for (const [provider, models] of Object.entries(data)) {
      insert.run(provider, JSON.stringify(models));
    }
  });
  tx();
  if (notify) {
    backupDbFile("pre-write");
    invalidateDbCache("pricing");
  }
}

/**
 * Clear all models.dev synced pricing data.
 */
export function clearModelsDevPricing(): void {
  const db = getDbInstance();
  db.prepare("DELETE FROM key_value WHERE namespace = 'models_dev_pricing'").run();
  clearModelsDevSnapshot();
  backupDbFile("pre-write");
  invalidateDbCache("pricing");
}

// ─── DB: model_capabilities table ────────────────────────

/**
 * Ensure the model_capabilities table exists.
 * Call this before any capability operations.
 */
export function ensureCapabilitiesTable(): void {
  const db = getDbInstance();
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_capabilities (
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      tool_call BOOLEAN,
      reasoning BOOLEAN,
      attachment BOOLEAN,
      structured_output BOOLEAN,
      temperature BOOLEAN,
      modalities_input TEXT,
      modalities_output TEXT,
      knowledge_cutoff TEXT,
      release_date TEXT,
      last_updated TEXT,
      status TEXT,
      family TEXT,
      open_weights BOOLEAN,
      limit_context INTEGER,
      limit_input INTEGER,
      limit_output INTEGER,
      interleaved_field TEXT,
      last_synced TEXT,
      capability_source TEXT NOT NULL DEFAULT 'legacy',
      model_type TEXT,
      canonical_model_id TEXT,
      reasoning_options TEXT,
      source_provider TEXT,
      native_model_id TEXT,
      PRIMARY KEY (provider, model_id)
    )
  `);
}

function defineEnumerableDataProperty<T extends object>(
  target: T,
  key: string,
  value: unknown
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function capabilitiesFromRows(rows: unknown[]): CapabilitiesByProvider {
  const result: CapabilitiesByProvider = {};

  for (const row of rows) {
    const record = toRecord(row);
    const prov = typeof record.provider === "string" ? record.provider : null;
    const mid = typeof record.model_id === "string" ? record.model_id : null;
    if (!prov || !mid) continue;

    if (!Object.hasOwn(result, prov)) {
      defineEnumerableDataProperty(result, prov, {});
    }
    defineEnumerableDataProperty(result[prov], mid, mapCapabilityRecord(record));
  }

  return result;
}

/**
 * Uncached full-table models.dev capability read for build-local snapshots.
 * Shares mapping with the ordinary all-row API but never mutates the module-global
 * `cachedCapabilities` / `cachedCapabilitiesLoadedAll` runtime cache.
 */
export function loadAllSyncedCapabilitiesUncached(): CapabilitiesByProvider {
  const db = getDbInstance();
  ensureCapabilitiesTable();
  const rows = db.prepare("SELECT * FROM model_capabilities").all();
  return capabilitiesFromRows(filterCurrentCapabilityRows(rows));
}

/**
 * Read synced capabilities from `model_capabilities` table.
 */
export function getSyncedCapabilities(provider?: string, modelId?: string): CapabilitiesByProvider {
  const currentDb = getDbInstance();
  const currentVersion = getModelCatalogCacheVersion();
  if (cachedCapabilitiesDb !== currentDb || cachedCapabilitiesVersion !== currentVersion) {
    cachedCapabilities = null;
    cachedCapabilitiesLoadedAll = false;
  }
  if (cachedCapabilitiesLoadedAll) {
    if (!provider) {
      return cachedCapabilities || {};
    }

    if (!modelId) {
      return cachedCapabilities?.[provider] ? { [provider]: cachedCapabilities[provider] } : {};
    }

    const providerCaps = cachedCapabilities?.[provider];
    return providerCaps?.[modelId] ? { [provider]: { [modelId]: providerCaps[modelId] } } : {};
  }

  const db = getDbInstance();
  ensureCapabilitiesTable();

  let query = "SELECT * FROM model_capabilities";
  const params: (string | number)[] = [];

  if (provider) {
    query += " WHERE provider = ?";
    params.push(provider);
    if (modelId) {
      query += " AND model_id = ?";
      params.push(modelId);
    }
  }

  const result = capabilitiesFromRows(
    filterCurrentCapabilityRows(db.prepare(query).all(...params))
  );

  if (!provider && !modelId) {
    cachedCapabilities = result;
    cachedCapabilitiesLoadedAll = true;
    cachedCapabilitiesDb = currentDb;
    cachedCapabilitiesVersion = currentVersion;
  }

  return result;
}

/**
 * Resolved providers/aliases to also try when looking up a synced capability.
 * Required because models.dev has historically stored capability rows under the
 * alias side of an alias pair (e.g. "opencode-zen") while the catalog & combo
 * targets reference the canonical id (e.g. "opencode"). Without this fallback,
 * combos whose targets use the canonical id (e.g. "Opencode FREE Omni" → all
 * `opencode/...` models) end up with `context_length: null` in the catalog.
 */
const SYNCED_CAPABILITY_FALLBACK_ALIASES: Record<string, string[]> = {
  opencode: ["opencode-zen"],
  "opencode-zen": ["opencode"],
};

function lookupSyncedCapabilityWithFallbacks(
  provider: string,
  modelId: string,
  lookup: (provider: string) => ModelCapabilityEntry | null
): ModelCapabilityEntry | null {
  const direct = lookup(provider);
  if (direct) return direct;

  const fallbacks = SYNCED_CAPABILITY_FALLBACK_ALIASES[provider];
  if (fallbacks) {
    for (const alt of fallbacks) {
      const found = lookup(alt);
      if (found) return found;
    }
  }

  return null;
}

export function getSyncedCapability(
  provider: string,
  modelId: string,
  bulk?: CapabilitiesByProvider | null
): ModelCapabilityEntry | null {
  if (!provider || !modelId) return null;

  if (bulk) {
    return (
      lookupSyncedCapabilityWithFallbacks(provider, modelId, (p) => bulk[p]?.[modelId] ?? null) ??
      getBundledModelsDevCapability(provider, modelId)
    );
  }

  // Fast path: every provider is in the in-memory cache, skip SQLite entirely.
  if (
    cachedCapabilitiesDb !== getDbInstance() ||
    cachedCapabilitiesVersion !== getModelCatalogCacheVersion()
  ) {
    cachedCapabilities = null;
    cachedCapabilitiesLoadedAll = false;
  }
  if (cachedCapabilitiesLoadedAll) {
    return (
      lookupSyncedCapabilityWithFallbacks(
        provider,
        modelId,
        (p) => cachedCapabilities?.[p]?.[modelId] ?? null
      ) ?? getBundledModelsDevCapability(provider, modelId)
    );
  }

  // Cold path: hit SQLite. Prepare the statement once, reuse for every alias.
  const db = getDbInstance();
  ensureCapabilitiesTable();
  const stmt = db.prepare(
    "SELECT * FROM model_capabilities WHERE provider = ? AND model_id = ? LIMIT 1"
  );
  return (
    lookupSyncedCapabilityWithFallbacks(provider, modelId, (p) => {
      const row = stmt.get(p, modelId);
      if (!row) return null;
      const record = toRecord(row);
      if (record.capability_source === "models-dev" && !isCurrentModelsDevOverlay(true))
        return null;
      return mapCapabilityRecord(record);
    }) ?? getBundledModelsDevCapability(provider, modelId)
  );
}

/**
 * Save synced capabilities to `model_capabilities` table (full replace).
 */
export function saveModelsDevCapabilities(data: CapabilitiesByProvider, notify = true): void {
  const db = getDbInstance();
  ensureCapabilitiesTable();

  const del = db.prepare("DELETE FROM model_capabilities WHERE capability_source = 'models-dev'");
  const insert = db.prepare(`
    INSERT INTO model_capabilities (
      provider, model_id, tool_call, reasoning, attachment, structured_output,
      temperature, modalities_input, modalities_output, knowledge_cutoff,
      release_date, last_updated, status, family, open_weights,
      limit_context, limit_input, limit_output, interleaved_field, last_synced, capability_source,
      model_type, canonical_model_id, reasoning_options, source_provider, native_model_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'models-dev', ?, ?, ?, ?, ?)
    ON CONFLICT(provider, model_id) DO UPDATE SET
      tool_call=excluded.tool_call, reasoning=excluded.reasoning, attachment=excluded.attachment,
      structured_output=excluded.structured_output, temperature=excluded.temperature,
      modalities_input=excluded.modalities_input, modalities_output=excluded.modalities_output,
      knowledge_cutoff=excluded.knowledge_cutoff, release_date=excluded.release_date,
      last_updated=excluded.last_updated, status=excluded.status, family=excluded.family,
      open_weights=excluded.open_weights, limit_context=excluded.limit_context,
      limit_input=excluded.limit_input, limit_output=excluded.limit_output,
      interleaved_field=excluded.interleaved_field, last_synced=excluded.last_synced,
      capability_source='models-dev',
      model_type=excluded.model_type, canonical_model_id=excluded.canonical_model_id,
      reasoning_options=excluded.reasoning_options, source_provider=excluded.source_provider,
      native_model_id=excluded.native_model_id
    WHERE model_capabilities.capability_source IN ('legacy', 'models-dev')
  `);

  const now = new Date().toISOString();
  let changed = false;
  const tx = db.transaction(() => {
    if (del.run().changes > 0) changed = true;
    for (const [provider, models] of Object.entries(data)) {
      for (const [modelId, cap] of Object.entries(models)) {
        const info = insert.run(
          provider,
          modelId,
          cap.tool_call === null ? null : cap.tool_call ? 1 : 0,
          cap.reasoning === null ? null : cap.reasoning ? 1 : 0,
          cap.attachment === null ? null : cap.attachment ? 1 : 0,
          cap.structured_output === null ? null : cap.structured_output ? 1 : 0,
          cap.temperature === null ? null : cap.temperature ? 1 : 0,
          cap.modalities_input,
          cap.modalities_output,
          cap.knowledge_cutoff,
          cap.release_date,
          cap.last_updated,
          cap.status,
          cap.family,
          cap.open_weights === null ? null : cap.open_weights ? 1 : 0,
          cap.limit_context,
          cap.limit_input,
          cap.limit_output,
          cap.interleaved_field,
          now,
          cap.model_type ?? null,
          cap.canonical_model_id ?? null,
          cap.reasoning_options ?? null,
          cap.source_provider ?? null,
          cap.native_model_id ?? modelId
        );
        if (info.changes > 0) changed = true;
      }
    }
  });
  tx();
  if (notify) {
    backupDbFile("pre-write");
    cachedCapabilities = null;
    cachedCapabilitiesLoadedAll = false;
    if (changed) invalidateDbCache("model-capabilities");
  }
}

/**
 * Insert-or-replace one provider's capability rows without wiping the table.
 * Used by the OpenRouter live catalog walk so architecture.input_modalities
 * survive into the next combo LCD (#12613).
 */
export function upsertSyncedCapabilities(
  provider: string,
  models: Record<string, ModelCapabilityEntry>
): void {
  if (!provider || Object.keys(models).length === 0) return;
  const db = getDbInstance();
  ensureCapabilitiesTable();
  const insert = db.prepare(`
    INSERT INTO model_capabilities (
      provider, model_id, tool_call, reasoning, attachment, structured_output,
      temperature, modalities_input, modalities_output, knowledge_cutoff,
      release_date, last_updated, status, family, open_weights,
      limit_context, limit_input, limit_output, interleaved_field, last_synced, capability_source,
      model_type, canonical_model_id, reasoning_options, source_provider, native_model_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovery', ?, ?, ?, ?, ?)
    ON CONFLICT(provider, model_id) DO UPDATE SET
      tool_call=excluded.tool_call,
      reasoning=excluded.reasoning,
      attachment=excluded.attachment,
      structured_output=excluded.structured_output,
      temperature=excluded.temperature,
      modalities_input=excluded.modalities_input,
      modalities_output=excluded.modalities_output,
      knowledge_cutoff=excluded.knowledge_cutoff,
      release_date=excluded.release_date,
      last_updated=excluded.last_updated,
      status=excluded.status,
      family=excluded.family,
      open_weights=excluded.open_weights,
      limit_context=excluded.limit_context,
      limit_input=excluded.limit_input,
      limit_output=excluded.limit_output,
      interleaved_field=excluded.interleaved_field,
      last_synced=excluded.last_synced,
      capability_source='discovery',
      model_type=COALESCE(excluded.model_type, model_capabilities.model_type),
      canonical_model_id=COALESCE(excluded.canonical_model_id, model_capabilities.canonical_model_id),
      reasoning_options=COALESCE(excluded.reasoning_options, model_capabilities.reasoning_options),
      source_provider=COALESCE(excluded.source_provider, model_capabilities.source_provider),
      native_model_id=COALESCE(excluded.native_model_id, model_capabilities.native_model_id)
  `);
  const now = new Date().toISOString();
  let changed = false;
  const tx = db.transaction(() => {
    for (const [modelId, cap] of Object.entries(models)) {
      const info = insert.run(
        provider,
        modelId,
        cap.tool_call === null ? null : cap.tool_call ? 1 : 0,
        cap.reasoning === null ? null : cap.reasoning ? 1 : 0,
        cap.attachment === null ? null : cap.attachment ? 1 : 0,
        cap.structured_output === null ? null : cap.structured_output ? 1 : 0,
        cap.temperature === null ? null : cap.temperature ? 1 : 0,
        cap.modalities_input,
        cap.modalities_output,
        cap.knowledge_cutoff,
        cap.release_date,
        cap.last_updated,
        cap.status,
        cap.family,
        cap.open_weights === null ? null : cap.open_weights ? 1 : 0,
        cap.limit_context,
        cap.limit_input,
        cap.limit_output,
        cap.interleaved_field,
        now,
        cap.model_type ?? null,
        cap.canonical_model_id ?? null,
        cap.reasoning_options ?? null,
        cap.source_provider ?? null,
        cap.native_model_id ?? modelId
      );
      if (info.changes > 0) changed = true;
    }
  });
  tx();
  cachedCapabilities = null;
  cachedCapabilitiesLoadedAll = false;
  if (changed) invalidateDbCache("model-capabilities");
}

/**
 * Clear all synced capability data.
 */
export function clearModelsDevCapabilities(): void {
  const db = getDbInstance();
  ensureCapabilitiesTable();
  const info = db
    .prepare("DELETE FROM model_capabilities WHERE capability_source = 'models-dev'")
    .run();
  clearModelsDevSnapshot();
  backupDbFile("pre-write");
  cachedCapabilities = null;
  cachedCapabilitiesLoadedAll = false;
  if (info.changes > 0) invalidateDbCache("model-capabilities");
}

// ─── Main sync function ──────────────────────────────────

/**
 * Fetch, transform, and save pricing + capabilities from models.dev.
 */
function subscribeToSync(shared: SharedModelsDevSync, signal?: AbortSignal): Promise<SyncResult> {
  if (signal?.aborted) return Promise.resolve(createAbortedSyncResult(false));
  const subscriber = Symbol("models-dev-refresh");
  shared.subscribers.add(subscriber);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: SyncResult | Error, failed = false) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      shared.subscribers.delete(subscriber);
      if (!shared.completed && shared.subscribers.size === 0) shared.controller.abort();
      if (failed) reject(result);
      else resolve(result as SyncResult);
    };
    const onAbort = () => finish(createAbortedSyncResult(false));
    signal?.addEventListener("abort", onAbort, { once: true });
    shared.promise.then(
      (result) => finish(result),
      (error: Error) => finish(error, true)
    );
  });
}

/** Manual and periodic refresh share one operation; cancellation releases only its caller. */
export async function syncModelsDev(opts?: SyncOptions): Promise<SyncResult> {
  if (opts?.signal?.aborted) return createAbortedSyncResult(opts?.dryRun ?? false);
  if (opts?.dryRun) return performModelsDevSync(opts);
  const key = JSON.stringify([
    opts?.force === true,
    opts?.syncCapabilities !== false,
    opts?.maxRetries ?? 3,
  ]);
  if (sharedSync && !sharedSync.completed && !sharedSync.controller.signal.aborted) {
    const current = sharedSync;
    if (current.key === key) return subscribeToSync(current, opts?.signal);
    // A caller asking for a different refresh mode waits for the current commit.
    await subscribeToSync(current, opts?.signal);
    if (opts?.signal?.aborted) return createAbortedSyncResult(false);
    return syncModelsDev(opts);
  }
  const controller = new AbortController();
  let shared: SharedModelsDevSync;
  const promise = performModelsDevSync({ ...opts, signal: controller.signal }).finally(() => {
    shared.completed = true;
    if (sharedSync === shared) sharedSync = null;
  });
  shared = { key, controller, promise, subscribers: new Set(), completed: false };
  sharedSync = shared;
  return subscribeToSync(shared, opts?.signal);
}

async function performModelsDevSync(opts?: SyncOptions): Promise<SyncResult> {
  const dryRun = opts?.dryRun ?? false;
  const syncCapabilities = opts?.syncCapabilities ?? true;
  const maxRetries = opts?.maxRetries ?? 3;
  const signal = opts?.signal;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      return createAbortedSyncResult(dryRun);
    }

    try {
      const publicSnapshot = await fetchModelsDevPublicSnapshot(signal, { force: opts?.force });
      const raw = publicSnapshot.data;
      const previous = readModelsDevSnapshotMetadata();
      if (
        !dryRun &&
        previous?.source === MODELS_DEV_API_URL &&
        previous.sha256 === publicSnapshot.sha256 &&
        previous.transformVersion === MODELS_DEV_TRANSFORM_VERSION &&
        (!syncCapabilities || previous.capabilitiesSynced === true)
      ) {
        signal?.throwIfAborted();
        // 304 (or an identical 200) updates validators/check time, not capability rows.
        commitModelsDevSnapshot(
          {
            ...previous,
            checkedAt: publicSnapshot.checkedAt,
            etag: publicSnapshot.etag,
            lastModified: publicSnapshot.lastModified,
          },
          () => {}
        );
        return {
          success: true,
          modelCount: previous.modelCount ?? 0,
          providerCount: previous.providerCount ?? 0,
          capabilityCount: syncCapabilities ? (previous.capabilityCount ?? 0) : 0,
          dryRun,
        };
      }
      const pricing = transformModelsDevToPricing(raw);
      const capabilities = syncCapabilities ? transformModelsDevToCapabilities(raw) : {};

      const modelCount = Object.values(pricing).reduce(
        (sum, models) => sum + Object.keys(models).length,
        0
      );
      const providerCount = Object.keys(pricing).length;
      const capabilityCount = syncCapabilities
        ? Object.values(capabilities).reduce((sum, models) => sum + Object.keys(models).length, 0)
        : 0;

      if (signal?.aborted) {
        return createAbortedSyncResult(dryRun);
      }

      if (!dryRun) {
        backupDbFile("pre-write");
        commitModelsDevSnapshot(
          {
            source: MODELS_DEV_API_URL,
            fetchedAt: publicSnapshot.fetchedAt,
            savedAt: new Date().toISOString(),
            checkedAt: publicSnapshot.checkedAt,
            sha256: publicSnapshot.sha256,
            etag: publicSnapshot.etag,
            lastModified: publicSnapshot.lastModified,
            transformVersion: MODELS_DEV_TRANSFORM_VERSION,
            modelCount,
            providerCount,
            capabilityCount,
            capabilitiesSynced: syncCapabilities,
          },
          () => {
            saveModelsDevPricing(pricing, false);
            if (syncCapabilities) saveModelsDevCapabilities(capabilities, false);
          },
          raw
        );
        cachedCapabilities = null;
        cachedCapabilitiesLoadedAll = false;
        invalidateDbCache("pricing");
        if (syncCapabilities) invalidateDbCache("model-capabilities");
        lastSyncTime = new Date().toISOString();
        lastSyncModelCount = modelCount;
        lastSyncCapabilityCount = capabilityCount;
      }

      return {
        success: true,
        modelCount,
        providerCount,
        capabilityCount,
        dryRun,
        ...(dryRun ? { data: { pricing, capabilities } } : {}),
      };
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) {
        return createAbortedSyncResult(dryRun);
      }

      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s
        console.warn(
          `[MODELS_DEV] Sync attempt ${attempt + 1} failed, retrying in ${delayMs}ms:`,
          lastError.message
        );
        try {
          await sleepWithAbort(delayMs, signal);
        } catch (sleepError) {
          if (signal?.aborted || isAbortError(sleepError)) {
            return createAbortedSyncResult(dryRun);
          }
          throw sleepError;
        }
      }
    }
  }

  const message = lastError?.message || "Unknown error";
  console.warn(`[MODELS_DEV] Sync failed after ${maxRetries + 1} attempts:`, message);
  return {
    success: false,
    modelCount: 0,
    providerCount: 0,
    capabilityCount: 0,
    dryRun,
    error: message,
  };
}

// ─── Periodic sync ───────────────────────────────────────

/**
 * Start periodic models.dev sync (non-blocking).
 */
export function startPeriodicSync(intervalMs?: number): void {
  if (isModelsDevSyncEnvDisabled()) return;
  if (syncTimer) return; // Already running

  const interval = intervalMs ?? SYNC_INTERVAL_MS;
  activeSyncIntervalMs = interval;
  const syncToken = { stopped: false, controller: new AbortController() };
  activePeriodicSyncToken = syncToken;
  console.log(`[MODELS_DEV] Starting periodic sync every ${interval / 1000}s`);
  let periodicPromise: Promise<SyncResult> | null = null;

  const launchSync = () => {
    if (syncToken.stopped) {
      return Promise.resolve(createAbortedSyncResult(false));
    }

    if (periodicPromise) return periodicPromise;
    const promise = syncModelsDev({ signal: syncToken.controller.signal, force: true }).finally(
      () => {
        if (periodicPromise === promise) periodicPromise = null;
      }
    );
    periodicPromise = promise;
    return promise;
  };

  // Initial sync (non-blocking)
  launchSync()
    .then((result) => {
      if (result.success) {
        console.log(
          `[MODELS_DEV] Initial sync complete: ${result.modelCount} pricing entries, ${result.capabilityCount} capabilities from ${result.providerCount} providers`
        );
      }
    })
    .catch((err) => {
      console.warn("[MODELS_DEV] Initial sync error:", err instanceof Error ? err.message : err);
    });

  syncTimer = setInterval(() => {
    launchSync()
      .then((result) => {
        if (result.success) {
          console.log(`[MODELS_DEV] Periodic sync complete: ${result.modelCount} pricing entries`);
        }
      })
      .catch((err) => {
        console.warn("[MODELS_DEV] Periodic sync error:", err instanceof Error ? err.message : err);
      });
  }, interval);

  if (syncTimer && typeof syncTimer === "object" && "unref" in syncTimer) {
    (syncTimer as { unref?: () => void }).unref?.();
  }
}

/**
 * Stop periodic sync and cleanup timer.
 */
export function stopPeriodicSync(): void {
  if (activePeriodicSyncToken) {
    activePeriodicSyncToken.stopped = true;
    activePeriodicSyncToken.controller.abort();
    activePeriodicSyncToken = null;
  }

  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
    console.log("[MODELS_DEV] Periodic sync stopped");
  }
}

/**
 * Get current sync status.
 */
export function getSyncStatus(): SyncStatus {
  // If the sync timer is active, it's enabled.
  const enabled = syncTimer !== null;
  const snapshot = readModelsDevSnapshotMetadata();
  const lastCheck = snapshot?.checkedAt || snapshot?.savedAt || lastSyncTime;
  return {
    enabled,
    lastSync: snapshot?.savedAt || lastSyncTime,
    lastSyncModelCount: snapshot?.modelCount ?? lastSyncModelCount,
    lastSyncCapabilityCount: snapshot?.capabilityCount ?? lastSyncCapabilityCount,
    lastCheck,
    nextSync:
      syncTimer && lastCheck
        ? new Date(new Date(lastCheck).getTime() + activeSyncIntervalMs).toISOString()
        : null,
    intervalMs: activeSyncIntervalMs,
    snapshot,
  };
}

// ─── Init (called from instrumentation-node.ts) ───────────────────

/**
 * Initialize models.dev sync if enabled.
 */
export async function initModelsDevSync(): Promise<void> {
  if (isModelsDevSyncEnvDisabled()) {
    console.log("[MODELS_DEV] Disabled (MODELS_DEV_SYNC_ENABLED=0)");
    return;
  }

  const { getSettings } = await import("@/lib/db/settings");
  const settings = await getSettings();

  if (!isModelsDevSyncEnvForcedOn() && settings.modelsDevSyncEnabled !== true) {
    console.log("[MODELS_DEV] Disabled (enable via Settings > AI or MODELS_DEV_SYNC_ENABLED=1)");
    return;
  }

  const interval = settings.modelsDevSyncInterval as number | undefined;
  startPeriodicSync(interval);
}
