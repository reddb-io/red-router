// A short digest of the LLM catalog one API key sees (models, combos, their members
// and parameters). Clients cache /v1/models; when the version they get back on a
// response differs from the one they cached, the catalog changed and they re-read it.
import { createHash } from "node:crypto";

// A combo edit or a new account shows up in the version within this window.
const TTL_MS = 15_000;
const cache = new Map(); // key -> { version, expiresAt, pending }

async function compute(apiKey) {
  const { buildModelsList } = await import("@/app/api/v1/models/route.js");
  const { getApiKeyModelIdFormat } = await import("@/lib/db/repos/apiKeysRepo.js");
  // The catalog this key reads: a flat key's version moves with its flat entries.
  const idFormat = apiKey ? await getApiKeyModelIdFormat(apiKey) : "prefixed";
  const list = await buildModelsList(["llm"], { apiKey, skipDynamicFetch: true, idFormat });
  return createHash("sha256").update(JSON.stringify(list)).digest("hex").slice(0, 16);
}

function refresh(key, apiKey) {
  const entry = cache.get(key);
  if (entry?.pending) return entry.pending;
  const pending = compute(apiKey)
    .then((version) => {
      cache.set(key, { version, expiresAt: Date.now() + TTL_MS, pending: null });
      return version;
    })
    .catch(() => {
      const stale = cache.get(key);
      cache.set(key, { version: stale?.version ?? null, expiresAt: Date.now() + TTL_MS, pending: null });
      return stale?.version ?? null;
    });
  cache.set(key, { version: entry?.version ?? null, expiresAt: entry?.expiresAt ?? 0, pending });
  return pending;
}

/** The current version, computing it when missing or expired. */
export async function getCatalogVersion(apiKey = null) {
  const key = apiKey || "local";
  const entry = cache.get(key);
  if (entry?.version && entry.expiresAt > Date.now()) return entry.version;
  return refresh(key, apiKey);
}

/**
 * The last known version without waiting: for the chat path, where the catalog must
 * never add latency. An expired or missing entry is refreshed in the background.
 */
export function peekCatalogVersion(apiKey = null) {
  const key = apiKey || "local";
  const entry = cache.get(key);
  if (!entry?.version || entry.expiresAt <= Date.now()) refresh(key, apiKey).catch(() => {});
  return entry?.version ?? null;
}

export function resetCatalogVersions() {
  cache.clear();
}
