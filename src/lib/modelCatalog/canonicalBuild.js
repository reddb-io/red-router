// Canonical model identity: which underlying model ("vendor/model", as in
// models.dev's models/ tree) a provider's offer serves. Pure helpers shared by
// scripts/refresh-catalog-snapshots.mjs (which builds snapshot/canonical-map.json
// from the models.dev repository) and ./canonical.js (the runtime lookup).
//
// models.dev keeps the link in each provider TOML as `base_model`, but drops it
// from the published api.json / catalog.json, so the map is built from the repo.

/**
 * A model id reduced to what tells models apart across providers: the last path
 * segment, lower case, "." as "-", without a free/latest marker or a date suffix.
 * "anthropic/claude-sonnet-4.5" and "claude-sonnet-4-5" normalize alike.
 */
export function normalizeModelName(id) {
  return String(id || "")
    .toLowerCase()
    .split("/").pop()
    .replace(/:free$|-free$/, "")
    .replace(/\./g, "-")
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "")
    .replace(/-latest$/, "");
}

/** normalized name → canonical ids with that name (more than one means ambiguous). */
export function indexByNormalizedName(canonicalIds) {
  const index = new Map();
  for (const id of canonicalIds) {
    const key = normalizeModelName(id);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(id);
  }
  return index;
}

/**
 * Build the canonical map.
 * @param {{ canonicalIds: string[], offers: Array<{ provider: string, id: string, baseModel?: string|null }>, source?: object }} input
 * @returns {{ generatedAt: string, source: object|null, models: string[],
 *   offers: Record<string, Record<string, string>>, inferred: Record<string, Record<string, string>> }}
 *   `offers` holds links models.dev states (base_model, or the vendor's own id);
 *   `inferred` holds unique normalized-name matches, kept apart as guesses.
 */
export function buildCanonicalMap({ canonicalIds, offers, source = null }) {
  const canonical = new Set(canonicalIds);
  const index = indexByNormalizedName(canonicalIds);
  const explicit = {};
  const inferred = {};
  const put = (target, provider, id, value) => { (target[provider] ||= {})[id] = value; };
  for (const { provider, id, baseModel } of offers) {
    if (baseModel && canonical.has(baseModel)) put(explicit, provider, id, baseModel);
    else if (canonical.has(`${provider}/${id}`)) put(explicit, provider, id, `${provider}/${id}`);
    else if (canonical.has(id)) put(explicit, provider, id, id);
    else {
      const candidates = index.get(normalizeModelName(id)) || [];
      if (candidates.length === 1) put(inferred, provider, id, candidates[0]);
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    source,
    models: [...canonical].sort(),
    offers: explicit,
    inferred,
  };
}
