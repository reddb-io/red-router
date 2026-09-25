// Live OpenCode catalogs: which Go models exist today, and which System One (JEV)
// models Zen serves. Each list is fetched from OpenCode's public /models, cached
// for OPENCODE_CATALOG_TTL_MS, and merged with the built-in registry, which stays
// the fallback when OpenCode cannot be reached and the metadata source for the
// models it already knows.
//
// Models the built-in list lacks are registered as runtime models so routing
// (endpoint choice per model) sees them too, not only /v1/models.

import {
  OPENCODE_CATALOG_RETRY_MS,
  OPENCODE_CATALOG_TIMEOUT_MS,
  OPENCODE_CATALOG_TTL_MS,
  OPENCODE_DEFAULT_FORMATS,
  OPENCODE_GO_MODELS_URL,
  OPENCODE_NPM_FORMATS,
  OPENCODE_SYSTEM_ONE_ID_RE,
  OPENCODE_ZEN_MODELS_URL,
} from "../config/opencodeCatalog.js";
import { PROVIDER_ID_TO_ALIAS, getProviderModels, isValidModel, registerRuntimeModels } from "../config/providerModels.js";
import { normalizeModel } from "../providers/models/schema.js";

const GO_PROVIDER_ID = "opencode-go";
const ZEN_PROVIDER_ID = "opencode-zen";
const SYSTEM_ONE_KIND = "systemone";

/** @type {Map<string, { ids: string[]|null, at: number, retryAt: number, inflight: Promise<string[]|null>|null }>} */
const lists = new Map();

/**
 * The OpenCode Go models to offer: the live /zen/go/v1/models list when reachable,
 * the built-in list otherwise. A known id keeps its built-in entry (name, endpoint
 * formats); a new one takes its name and endpoint from models.dev when it has the
 * model, else a /chat/completions default.
 * @param {object} [options]
 * @param {Record<string, object>} [options.modelsDev] - models.dev browse entries of opencode-go, by id
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.now]
 * @returns {Promise<{ models: object[], source: "live"|"builtin" }>}
 */
export async function resolveOpenCodeGoModels({ modelsDev = null, fetchImpl, now = Date.now() } = {}) {
  const builtIn = getProviderModels(alias(GO_PROVIDER_ID));
  const ids = await liveIds(OPENCODE_GO_MODELS_URL, { fetchImpl, now });
  if (!ids) return { models: builtIn, source: "builtin" };
  const known = new Map(builtIn.map((model) => [model.id, model]));
  const models = ids.map((id) => known.get(id) || discoveredGoModel(id, modelsDev?.[id]));
  registerRuntimeModels(alias(GO_PROVIDER_ID), models.filter((model) => !known.has(model.id)));
  return { models, source: "live" };
}

/**
 * Make sure routing knows a Go model before a request is sent: an id missing from
 * the built-in list waits for the live list (cached), so a new model reaches the
 * endpoint it is served on. Known ids return at once.
 * @param {string} modelId
 * @param {object} [options] - resolveOpenCodeGoModels options, except `modelsDev`
 *   is a function, only called when the live list is needed
 */
export async function ensureOpenCodeGoModel(modelId, { modelsDev, ...options } = {}) {
  const id = String(modelId || "").replace(/\([^()]+\)\s*$/, "").trim();
  if (!id || isValidModel(alias(GO_PROVIDER_ID), id)) return;
  await resolveOpenCodeGoModels({ ...options, modelsDev: modelsDev?.() || null });
}

/**
 * The System One models OpenCode Zen serves: the JEV ids of the live
 * /zen/v1/models list, else the built-in Zen JEV entries.
 * @returns {Promise<{ models: object[], source: "live"|"builtin" }>}
 */
export async function resolveOpenCodeZenSystemOneModels({ fetchImpl, now = Date.now() } = {}) {
  const builtIn = getProviderModels(alias(ZEN_PROVIDER_ID)).filter((model) => model.kind === SYSTEM_ONE_KIND);
  const ids = await liveIds(OPENCODE_ZEN_MODELS_URL, { fetchImpl, now });
  const jevIds = ids?.filter((id) => OPENCODE_SYSTEM_ONE_ID_RE.test(id)) || [];
  if (!jevIds.length) return { models: builtIn, source: "builtin" };
  const known = new Map(builtIn.map((model) => [model.id, model]));
  const models = jevIds.map((id) => known.get(id) || normalizeModel({ id, kind: SYSTEM_ONE_KIND }));
  registerRuntimeModels(alias(ZEN_PROVIDER_ID), models.filter((model) => !known.has(model.id)));
  return { models, source: "live" };
}

/** Test hook: forget every cached list and discovered model. */
export function resetOpenCodeCatalogs() {
  lists.clear();
  registerRuntimeModels(alias(GO_PROVIDER_ID), null);
  registerRuntimeModels(alias(ZEN_PROVIDER_ID), null);
}

function alias(providerId) {
  return PROVIDER_ID_TO_ALIAS[providerId] || providerId;
}

function discoveredGoModel(id, facts) {
  const formats = OPENCODE_NPM_FORMATS[facts?.a] || OPENCODE_DEFAULT_FORMATS;
  return normalizeModel({
    id,
    ...(facts?.n ? { name: facts.n } : {}),
    ...structuredClone(formats),
  });
}

/**
 * One public /models list as ids, cached per URL. A fresh list is served from
 * memory; a stale one is refetched (concurrent callers share the fetch). On
 * failure the last good list stays in use, and the network is retried after
 * OPENCODE_CATALOG_RETRY_MS. Null when no list was ever fetched.
 */
async function liveIds(url, { fetchImpl, now }) {
  const entry = lists.get(url) || { ids: null, at: 0, retryAt: 0, inflight: null };
  lists.set(url, entry);
  if (entry.ids && now - entry.at < OPENCODE_CATALOG_TTL_MS) return entry.ids;
  if (now < entry.retryAt) return entry.ids;
  if (!entry.inflight) {
    entry.inflight = fetchIds(url, fetchImpl || fetch)
      .then((ids) => {
        if (ids) Object.assign(entry, { ids, at: now, retryAt: 0 });
        else entry.retryAt = now + OPENCODE_CATALOG_RETRY_MS;
        return entry.ids;
      })
      .finally(() => { entry.inflight = null; });
  }
  return entry.inflight;
}

async function fetchIds(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(OPENCODE_CATALOG_TIMEOUT_MS),
    });
    if (!response?.ok) return null;
    const body = await response.json();
    const data = Array.isArray(body) ? body : body?.data;
    const ids = Array.isArray(data)
      ? [...new Set(data.map((model) => model?.id).filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))]
      : [];
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}
