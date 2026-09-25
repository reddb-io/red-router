// Runtime lookup of a model's canonical identity ("vendor/model") from the map
// vendored in snapshot/canonical-map.json (see ./canonicalBuild.js and
// scripts/refresh-catalog-snapshots.mjs). Groundwork for flat model ids: the
// same model offered by several providers shares one canonical id.
import fs from "node:fs";
import { modelsDevProviderId } from "./browse.js";
import { indexByNormalizedName, normalizeModelName } from "./canonicalBuild.js";

const MAP_URL = new URL("./snapshot/canonical-map.json", import.meta.url);

let loaded = null;

function load() {
  if (loaded) return loaded;
  let map = { models: [], offers: {}, inferred: {} };
  try {
    map = JSON.parse(fs.readFileSync(MAP_URL, "utf8"));
  } catch {
    // No map: only ids that are already canonical resolve.
  }
  loaded = { map, models: new Set(map.models || []), index: indexByNormalizedName(map.models || []) };
  return loaded;
}

/**
 * The canonical model an offer serves, or null when nothing links it.
 * @param {string} providerId RedRouter provider id (mapped onto models.dev's)
 * @param {string} modelId    the id that provider uses
 * @returns {{ id: string, how: "stated"|"inferred"|"same-id"|"name" }|null}
 *   stated   — models.dev links it (base_model, or the vendor's own offer)
 *   inferred — models.dev's unique normalized-name match, precomputed
 *   same-id  — the offer id is itself a canonical id (OpenRouter-style ids)
 *   name     — a unique normalized-name match on an offer the map has not seen
 */
export function canonicalFor(providerId, modelId) {
  if (!modelId) return null;
  const { map, models, index } = load();
  const md = modelsDevProviderId(providerId);
  const stated = map.offers?.[md]?.[modelId];
  if (stated) return { id: stated, how: "stated" };
  const inferred = map.inferred?.[md]?.[modelId];
  if (inferred) return { id: inferred, how: "inferred" };
  if (models.has(modelId)) return { id: modelId, how: "same-id" };
  const candidates = index.get(normalizeModelName(modelId)) || [];
  return candidates.length === 1 ? { id: candidates[0], how: "name" } : null;
}

/** Test hook. */
export function resetCanonicalMap() {
  loaded = null;
}
