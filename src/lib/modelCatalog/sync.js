// Daily refresh of model capabilities from models.dev.
//
// Downloads the catalog, keeps only what differs from the hand-written tables,
// and writes it next to the database. Failures are swallowed on purpose: a
// stale or missing file just means those tables keep deciding on their own.

import fs from "node:fs";
import path from "node:path";
import { CATALOG_FILE, CATALOG_RAW_FILE, CATALOG_VERSION, invalidateCatalog, installCatalogSource } from "open-sse/providers/catalogOverride.js";

const CATALOG_URL = "https://models.dev/api.json";
// Provider-agnostic model facts from the same models.dev project
// (anomalyco/models.dev): keyed "<vendor>/<model-id>", one entry per model
// regardless of who serves it. Read as the fallback limits layer when a
// provider is not covered by the api.json deltas below.
const MODELS_URL = "https://models.dev/models.json";
// Offline baseline: snapshots vendored into the repo seed the cache when the API is unreachable,
// so a fresh install (or an outage before the first successful sync) still serves real limits.
// The scheduled sync overwrites the cache with fresh data as soon as the API answers again.
const SNAPSHOT_API_URL = new URL("./snapshot/api.json", import.meta.url);
const SNAPSHOT_MODELS_URL = new URL("./snapshot/models.json", import.meta.url);
const FETCH_TIMEOUT_MS = 60000;

export const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;   // let the server boot and serve first requests
const RETRY_DELAY_MS = 30 * 60 * 1000;

const MODALITY_BY_INPUT = { image: "vision", pdf: "pdf", audio: "audioInput", video: "videoInput" };
// Ignore limit differences below this: gateways round 200000 vs 202752.
const LIMIT_TOLERANCE = 0.1;

// red-router provider id -> models.dev provider id, for context/maxOutput only.
// Providers absent here keep whatever the local pattern table resolves; names
// that already match are resolved automatically.
export const PROVIDER_ALIASES = {
  "glm": "zai",
  "glm-cn": "zhipuai",
  "claude": "anthropic",
  "gemini": "google",
  "kimi": "moonshotai",
  "kimi-cn": "moonshotai-cn",
  "qwen": "alibaba",
  "qwen-cn": "alibaba-cn",
  "zhipu": "zhipuai",
  "hunyuan": "tencent",
  "doubao": "volcengine",
  "cloudflare-ai": "cloudflare-workers-ai",
};

let state = { running: false, lastSync: null, lastError: null, lastResult: null, etag: null, fileVersion: null };
let timer = null;

export function getSyncState() {
  return { ...state, file: CATALOG_FILE, url: CATALOG_URL, intervalMs: SYNC_INTERVAL_MS };
}

// "zai-org/GLM-4.6V:free" -> "glm-4.6v"
function baseId(modelId) {
  const withoutVendor = modelId.includes("/") ? modelId.split("/").pop() : modelId;
  return withoutVendor.toLowerCase().split(":")[0];
}

function writeAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, contents, "utf8");
  fs.renameSync(`${file}.tmp`, file);
}

// Trimmed copy of the upstream catalog, kept for the add-models skill: same
// models, ~470KB instead of 4.3MB.
function slim(catalog) {
  const out = {};
  for (const [providerId, provider] of Object.entries(catalog)) {
    const models = {};
    for (const [modelId, model] of Object.entries(provider?.models || {})) {
      models[modelId] = {
        i: (model?.modalities?.input || []).filter((x) => x !== "text"),
        c: model?.limit?.context,
        o: model?.limit?.output,
        r: model?.reasoning || undefined,
      };
    }
    out[providerId] = models;
  }
  return out;
}

// Provider-agnostic limits from models.dev/models.json, keyed by model id
// alone ("zai-org/glm-4.6" -> glm-4.6). The provider-keyed api.json deltas
// above only cover aliased gateways; this fallback gives every model with a
// models.dev entry a real window even when the gateway serving it is unknown.
// Failure is swallowed: a missing layer just means nothing to fall back to.
// The provider-agnostic limits layer, built the same way from either the live models.json or the
// vendored snapshot.
function buildModelLimits(models) {
  const limits = {};
  for (const model of Object.values(models || {})) {
    const id = baseId(model?.id);
    const { context, output } = model?.limit || {};
    if (id && context > 0) limits[id] = { context, output: output > 0 ? output : undefined };
  }
  return Object.keys(limits).length ? limits : null;
}

async function fetchModelLimits() {
  try {
    const response = await fetch(MODELS_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;
    return buildModelLimits(await response.json());
  } catch {
    return null;
  }
}

// Offline baseline: build the catalog from a static snapshot. The @opencode-ai/models package
// (official typed client from the models.dev authors) ships a bundled snapshot that updates via
// version bumps; the files vendored into the repo are the fallback when the package is not
// resolvable. Used when the cache does not exist yet and the API is unreachable, so a fresh
// install serves real limits instead of an empty catalog. The next successful sync overwrites
// the cache with fresh data.
async function readSeedSnapshot() {
  try {
    const npm = await import("@opencode-ai/models/snapshot");
    const catalog = npm.providers ?? npm.default?.providers;
    const models = npm.models ?? npm.default?.models;
    if (catalog && models) return { catalog, models, source: "npm snapshot" };
  } catch {
    // Package not resolvable: fall back to the snapshots vendored into the repo.
  }
  const catalog = readSnapshotFile(SNAPSHOT_API_URL);
  const models = readSnapshotFile(SNAPSHOT_MODELS_URL);
  return catalog && models ? { catalog, models, source: "vendored snapshot" } : null;
}

export async function seedFromSnapshot() {
  if (fs.existsSync(CATALOG_FILE)) return null;
  const seed = await readSeedSnapshot();
  if (!seed) return null;
  const entries = await collectEntries();
  const { models, providers } = build(seed.catalog, entries);
  const modelLimits = buildModelLimits(seed.models);
  const serialized = JSON.stringify({ v: CATALOG_VERSION, etag: null, syncedAt: Date.now(), models, providers, modelLimits });
  writeAtomic(CATALOG_FILE, serialized);
  writeAtomic(CATALOG_RAW_FILE, JSON.stringify(slim(seed.catalog)));
  invalidateCatalog();
  await installCatalogSource().catch(() => {});
  return {
    status: "seeded",
    source: seed.source,
    models: Object.keys(models).length,
    modelLimits: modelLimits ? Object.keys(modelLimits).length : 0,
  };
}

function readSnapshotFile(url) {
  try {
    return JSON.parse(fs.readFileSync(url, "utf8"));
  } catch {
    return null;
  }
}

export function build(catalog, entries) {
  const localIds = new Map();
  for (const { provider } of entries) {
    const upstreamId = PROVIDER_ALIASES[provider] || provider;
    let locals = localIds.get(upstreamId);
    if (!locals) localIds.set(upstreamId, (locals = []));
    if (!locals.includes(provider)) locals.push(provider);
  }

  const byProvider = {};
  const models = {};
  for (const [providerId, provider] of Object.entries(catalog)) {
    const locals = localIds.get(providerId) || [providerId];
    const modelsById = {};
    const seen = new Set();
    for (const [modelId, model] of Object.entries(provider?.models || {})) {
      const id = baseId(modelId);
      modelsById[id] = model;
      if (seen.has(id)) continue;
      seen.add(id);
      const declared = {};
      for (const input of model?.modalities?.input || []) {
        const key = MODALITY_BY_INPUT[input];
        if (key) declared[key] = true;
      }
      if (Object.keys(declared).length) {
        for (const local of locals) models[`${local}:${id}`] = declared;
        if (!locals.includes(providerId)) models[`${providerId}:${id}`] = declared;
      }
    }
    byProvider[providerId] = modelsById;
  }

  // Limits belong to the gateway — each truncates differently — so only the
  // matching provider's own numbers are used, keyed by provider + model.
  const providers = {};
  for (const { provider, model, contextLength, current } of entries) {
    const alias = PROVIDER_ALIASES[provider];
    const upstream = catalog[provider] ? provider : (alias && catalog[alias] ? alias : null);
    const entry = upstream && byProvider[upstream]?.[baseId(model)];
    if (!entry) continue;

    const delta = {};
    const { context, output } = entry.limit || {};
    if (context > 0 && !contextLength
      && Math.abs(context - current.contextWindow) / current.contextWindow > LIMIT_TOLERANCE) {
      delta.contextWindow = context;
    }
    if (output > 0
      && Math.abs(output - current.maxOutput) / current.maxOutput > LIMIT_TOLERANCE) {
      delta.maxOutput = output;
    }
    if (Object.keys(delta).length) (providers[provider] || (providers[provider] = {}))[model] = delta;
  }

  return { models, providers };
}

// Snapshot every registered model with the capabilities the hand-written tables
// resolve on their own, so build() can tell which upstream values are a change.
//
// The previous catalog MUST be detached first. Leaving it installed makes each
// delta relative to the last one, so a value that still agrees with upstream
// looks like "no change" and is dropped — the file erases itself over two runs.
async function collectEntries() {
  const [{ default: registry }, { getCapabilitiesForModel, setCatalogSource }] = await Promise.all([
    import("open-sse/providers/registry/index.js"),
    import("open-sse/providers/capabilities.js"),
  ]);
  setCatalogSource(null);

  const entries = [];
  for (const provider of registry) {
    for (const model of provider.models || []) {
      entries.push({
        provider: provider.id,
        model: model.id,
        contextLength: model.contextLength,
        current: getCapabilitiesForModel(provider.id, model.id),
      });
    }
  }
  return entries;
}

// Run one sync. Returns a summary, or null when it could not complete.
export async function syncModelCatalog() {
  if (state.running) return null;
  state.running = true;
  try {
    const headers = { accept: "application/json" };
    if (state.etag && state.fileVersion === CATALOG_VERSION) headers["if-none-match"] = state.etag;
    const response = await fetch(CATALOG_URL, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

    let result;
    if (response.status === 304) {
      result = { status: "unchanged" };
    } else if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    } else {
      // ~23ms to parse, once a day, on a server that is otherwise idle at this
      // point — not worth a worker thread.
      const catalog = await response.json();
      const etag = response.headers.get("etag") || null;
      const entries = await collectEntries();
      const { models, providers } = build(catalog, entries);
      const modelLimits = await fetchModelLimits();
      const serialized = JSON.stringify({ v: CATALOG_VERSION, etag, syncedAt: Date.now(), models, providers, modelLimits });

      writeAtomic(CATALOG_FILE, serialized);
      writeAtomic(CATALOG_RAW_FILE, JSON.stringify(slim(catalog)));

      state.etag = etag;
      state.fileVersion = CATALOG_VERSION;
      invalidateCatalog();
      result = {
        status: "updated",
        etag,
        bytes: Buffer.byteLength(serialized),
        models: Object.keys(models).length,
        providers: Object.keys(providers).length,
      };
      console.log(`[modelCatalog] ${result.models} models, ${result.providers} providers, ${(result.bytes / 1024).toFixed(1)}KB`);
    }

    state.lastSync = Date.now();
    state.lastError = null;
    state.lastResult = result;
    return result;
  } catch (error) {
    state.lastError = error?.message || String(error);
    console.log(`[modelCatalog] sync failed: ${state.lastError}`);
    // The API is down and the cache may be empty: seed from the vendored snapshot so the read
    // side still serves real limits instead of an empty catalog.
    const seeded = await seedFromSnapshot().catch(() => null);
    if (seeded) {
      state.lastError = null;
      state.lastResult = seeded;
      console.log(`[modelCatalog] seeded ${seeded.models} models from the ${seeded.source}`);
      return seeded;
    }
    return null;
  } finally {
    // collectEntries() detaches the reader; put it back whatever happened.
    await installCatalogSource().catch(() => {});
    state.running = false;
  }
}

// The etag lives in the file we wrote, so a restart can resume from it instead
// of re-downloading 4.3MB to be told nothing changed.
function restoreEtag() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
    state.etag = parsed.etag || null;
    state.fileVersion = parsed.v || 1;
    state.lastSync = fs.statSync(CATALOG_FILE).mtimeMs;
  } catch {
    state.etag = null;
    state.fileVersion = null;
  }
}

/** Cancel the scheduled sync (shutdown, tests). A later start re-reads the file's etag. */
export function stopModelCatalogSync() {
  if (timer) clearTimeout(timer);
  timer = null;
}

// Schedule the recurring sync. Disable entirely with MODEL_CATALOG_SYNC=off.
export function startModelCatalogSync() {
  if (timer) return;
  if (String(process.env.MODEL_CATALOG_SYNC || "").toLowerCase() === "off") return;
  restoreEtag();

  // No cache yet: seed from the vendored snapshot right away so the first boot serves real
  // limits even offline; the scheduled sync updates the cache from the API when reachable.
  if (!fs.existsSync(CATALOG_FILE)) {
    seedFromSnapshot()
      .then((seeded) => {
        if (seeded) console.log(`[modelCatalog] seeded ${seeded.models} models from the ${seeded.source}`);
      })
      .catch(() => {});
  }

  const schedule = (delay) => {
    timer = setTimeout(async () => {
      const result = await syncModelCatalog();
      schedule(result ? SYNC_INTERVAL_MS : RETRY_DELAY_MS);
    }, delay);
    timer.unref?.();
  };
  schedule(STARTUP_DELAY_MS);
}
