/**
 * openrouterCatalog.ts — Feature 09
 * Catálogo OpenRouter com cache persistente em arquivo JSON local.
 *
 * - TTL configurável via env OPENROUTER_CATALOG_TTL_MS (default: 24h)
 * - Fallback stale-if-error: retorna último snapshot válido se fetch falhar
 * - Atualização oportunista em background (não bloqueia o caller)
 */

import fs from "fs";
import path from "path";
import { invalidateModelCatalogCache } from "@/lib/db/readCache";
import {
  fetchOpenRouterModelFeeds,
  parseOpenRouterModelsResponse,
} from "@/lib/providerModels/openrouterModelFeeds";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_VERSION = 2;

function getTTL(): number {
  const env = process.env.OPENROUTER_CATALOG_TTL_MS;
  return env ? parseInt(env, 10) : DEFAULT_TTL_MS;
}

function getCacheFilePath(): string {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  const cacheDir = path.join(dataDir, "cache");
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return path.join(cacheDir, "openrouter-catalog.json");
}

interface CatalogEntry {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
    image?: string;
    request?: string;
  };
  top_provider?: {
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
    instruct_type?: string;
  };
  supported_parameters?: string[];
  created?: number;
  nativeModelId?: string;
  modelType?: string;
  supportedEndpoints?: string[];
  apiFormat?: string;
}

interface CacheFile {
  version?: number;
  fetchedAt: string;
  data: CatalogEntry[];
}

/** Read cached catalog from disk. Returns null if not found or unparseable. */
function readCache(): CacheFile | null {
  const filePath = getCacheFilePath();
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const cache = JSON.parse(raw) as CacheFile;
    if (typeof cache.fetchedAt !== "string" || !Number.isFinite(Date.parse(cache.fetchedAt)))
      return null;
    const data = parseOpenRouterModelsResponse({ data: cache.data }) as CatalogEntry[];
    return { version: cache.version, fetchedAt: cache.fetchedAt, data };
  } catch {
    return null;
  }
}

/** Write catalog to disk cache. */
function writeCache(data: CatalogEntry[]): void {
  const filePath = getCacheFilePath();
  const cache: CacheFile = {
    version: CACHE_VERSION,
    fetchedAt: new Date().toISOString(),
    data,
  };
  try {
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), "utf8");
  } catch (err) {
    console.warn("[OpenRouterCatalog] Failed to write cache:", err);
  }
}

/** Fetch fresh catalog from OpenRouter API. */
async function fetchFromAPI(): Promise<CatalogEntry[]> {
  return fetchOpenRouterModelFeeds(OPENROUTER_API_URL, (url) =>
    fetch(url, {
      headers: { "User-Agent": "RedRouter/2.0", Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    })
  ) as Promise<CatalogEntry[]>;
}

/**
 * Get OpenRouter model catalog.
 *
 * Returns { data, stale, cachedAt } where:
 * - data: list of models
 * - stale: true if data is from a stale cache (fetch failed)
 * - cachedAt: ISO string of when the data was cached (null if fresh fetch)
 */
export async function getOpenRouterCatalog(): Promise<{
  data: CatalogEntry[];
  stale: boolean;
  cachedAt: string | null;
  fromCache: boolean;
}> {
  const ttl = getTTL();
  const cache = readCache();
  const now = Date.now();

  // Return cached data if still within TTL
  if (cache && cache.fetchedAt) {
    const age = now - new Date(cache.fetchedAt).getTime();
    if (cache.version === CACHE_VERSION && age >= 0 && age < ttl) {
      return {
        data: cache.data,
        stale: false,
        cachedAt: cache.fetchedAt,
        fromCache: true,
      };
    }
  }

  // Cache expired or missing — attempt fresh fetch
  try {
    const data = await fetchFromAPI();
    writeCache(data);
    return { data, stale: false, cachedAt: null, fromCache: false };
  } catch (err) {
    console.warn("[OpenRouterCatalog] Fetch failed, using stale cache:", err);

    // Stale-if-error: return old cache if available
    if (cache) {
      return {
        data: cache.data,
        stale: true,
        cachedAt: cache.fetchedAt,
        fromCache: true,
      };
    }

    // No cache at all — return empty with error signal
    return { data: [], stale: true, cachedAt: null, fromCache: false };
  }
}

/**
 * Force-refresh the catalog cache (ignores TTL).
 * Used by admin endpoints and manual refresh actions.
 */
export async function refreshOpenRouterCatalog(): Promise<{
  data: CatalogEntry[];
  ok: boolean;
  error?: string;
}> {
  try {
    const data = await fetchFromAPI();
    writeCache(data);
    invalidateModelCatalogCache();
    return { data, ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { data: [], ok: false, error };
  }
}
