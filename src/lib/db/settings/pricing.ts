/**
 * db/settings/pricing.ts — Pricing data CRUD (user overrides, LiteLLM sync, models.dev sync).
 */

import { getDbInstance } from "../core";
import { backupDbFile } from "../backup";
import { getCachedPricing, invalidateDbCache } from "../readCache";
import { PROVIDER_ID_TO_ALIAS } from "@omniroute/open-sse/config/providerModels.ts";
import { type JsonRecord, toRecord } from "./shared";
import { getDefaultPricing } from "@/shared/constants/pricing";
import { getBundledModelsDevPricing } from "@/lib/catalog/modelsDevSeed";
import { readModelsDevSnapshotMetadata } from "../modelsDevSnapshot";
import { MODELS_DEV_SOURCE_URL, MODELS_DEV_TRANSFORM_VERSION } from "@/lib/modelsDevSync/transform";

type PricingModels = Record<string, JsonRecord>;
type PricingByProvider = Record<string, PricingModels>;
export type PricingSource = "bundled" | "default" | "litellm" | "modelsDev" | "user";
export type PricingSourceMap = Record<string, Record<string, PricingSource>>;

async function touchPricing(): Promise<void> {
  invalidateDbCache("pricing");
  try {
    const { clearTierCache } = await import("@omniroute/open-sse/services/tierResolver");
    clearTierCache();
  } catch {
    // fail-open: a missed tier invalidation must never break a price write
  }
}

function readPricingNamespace(
  db: ReturnType<typeof getDbInstance>,
  namespace: string
): PricingByProvider {
  const rows = db.prepare("SELECT key, value FROM key_value WHERE namespace = ?").all(namespace);
  const pricing: PricingByProvider = {};

  for (const row of rows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;

    try {
      pricing[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
    } catch {
      // Corrupted data — skip silently, fallback to lower layers
    }
  }

  return pricing;
}

function mergePricingLayers(layers: PricingByProvider[]): PricingByProvider {
  const mergedPricing: PricingByProvider = {};

  for (const layer of layers) {
    for (const [provider, models] of Object.entries(layer)) {
      if (!mergedPricing[provider]) {
        mergedPricing[provider] = { ...models };
        continue;
      }

      for (const [model, pricing] of Object.entries(models)) {
        mergedPricing[provider][model] = mergedPricing[provider][model]
          ? { ...(mergedPricing[provider][model] || {}), ...toRecord(pricing) }
          : pricing;
      }
    }
  }

  return mergedPricing;
}

function buildPricingSourceMap(layers: {
  bundled: PricingByProvider;
  defaults: PricingByProvider;
  litellm: PricingByProvider;
  modelsDev: PricingByProvider;
  user: PricingByProvider;
}): PricingSourceMap {
  const sourceMap: PricingSourceMap = {};
  const mergedPricing = mergePricingLayers([
    layers.bundled,
    layers.defaults,
    layers.litellm,
    layers.modelsDev,
    layers.user,
  ]);

  for (const [provider, models] of Object.entries(mergedPricing)) {
    sourceMap[provider] = {};

    for (const model of Object.keys(models)) {
      if (layers.user[provider]?.[model]) {
        sourceMap[provider][model] = "user";
      } else if (layers.modelsDev[provider]?.[model]) {
        sourceMap[provider][model] = "modelsDev";
      } else if (layers.litellm[provider]?.[model]) {
        sourceMap[provider][model] = "litellm";
      } else if (layers.defaults[provider]?.[model]) {
        sourceMap[provider][model] = "default";
      } else {
        sourceMap[provider][model] = "bundled";
      }
    }
  }

  return sourceMap;
}

function getPricingLayers() {
  const db = getDbInstance();
  const metadata = readModelsDevSnapshotMetadata();
  const compatible =
    metadata?.source === MODELS_DEV_SOURCE_URL &&
    metadata.transformVersion === MODELS_DEV_TRANSFORM_VERSION;

  return {
    bundled: getBundledModelsDevPricing() as PricingByProvider,
    defaults: getDefaultPricing(),
    litellm: readPricingNamespace(db, "pricing_synced"),
    // Old aliases mixed commercial products. Retain their data for recovery,
    // but only a versioned, atomically committed refresh can supply live prices.
    modelsDev: compatible ? readPricingNamespace(db, "models_dev_pricing") : {},
    user: readPricingNamespace(db, "pricing"),
  };
}

export async function getPricing() {
  const layers = getPricingLayers();
  // Merge: bundled → defaults → LiteLLM → models.dev → user (highest priority last).
  return mergePricingLayers([
    layers.bundled,
    layers.defaults,
    layers.litellm,
    layers.modelsDev,
    layers.user,
  ]);
}

/** One bulk read for a catalog build; matches request cost estimation precedence. */
export function getCatalogPricingSnapshot() {
  const layers = getPricingLayers();
  return {
    pricing: mergePricingLayers([
      layers.bundled,
      layers.defaults,
      layers.litellm,
      layers.modelsDev,
      layers.user,
    ]),
    userPricing: layers.user,
  };
}

export async function getPricingWithSources(): Promise<{
  pricing: PricingByProvider;
  sourceMap: PricingSourceMap;
}> {
  const layers = getPricingLayers();
  return {
    pricing: mergePricingLayers([
      layers.bundled,
      layers.defaults,
      layers.litellm,
      layers.modelsDev,
      layers.user,
    ]),
    sourceMap: buildPricingSourceMap(layers),
  };
}

export async function getPricingForModel(provider: string, model: string) {
  const pricing = (await getCachedPricing()) as PricingByProvider;

  const findKeyInsensitive = <T>(
    obj: Record<string, T> | undefined | null,
    key: string
  ): T | undefined => {
    if (!obj || !key) return undefined;
    const lowerKey = key.toLowerCase();
    for (const [k, v] of Object.entries(obj)) {
      if (k.toLowerCase() === lowerKey) return v;
    }
    return undefined;
  };

  const pLower = (provider || "").toLowerCase();
  let providerPricing = findKeyInsensitive<PricingModels>(pricing, pLower);

  if (!providerPricing) {
    const alias = findKeyInsensitive<string>(PROVIDER_ID_TO_ALIAS, pLower);
    if (alias) providerPricing = findKeyInsensitive(pricing, alias);
  }

  if (!providerPricing) {
    for (const [id, mappedAlias] of Object.entries(PROVIDER_ID_TO_ALIAS)) {
      if (typeof mappedAlias === "string" && mappedAlias.toLowerCase() === pLower) {
        providerPricing = findKeyInsensitive(pricing, id);
        if (providerPricing) break;
      }
    }
  }

  if (!providerPricing) return null;
  // Routing aliases apply to providers. Native model IDs are opaque: punctuation,
  // case, namespaces and versions cannot borrow another offering's economics.
  return providerPricing[model] || null;
}

export async function updatePricing(pricingData: PricingByProvider) {
  const db = getDbInstance();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('pricing', ?, ?)"
  );

  const rows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  const existing: PricingByProvider = {};
  for (const row of rows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    existing[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
  }

  const tx = db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      insert.run(provider, JSON.stringify({ ...(existing[provider] || {}), ...models }));
    }
  });
  tx();
  backupDbFile("pre-write");
  await touchPricing();
  const updated: PricingByProvider = {};
  const allRows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  for (const row of allRows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    updated[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
  }
  return updated;
}

export async function resetPricing(provider: string, model?: string) {
  const db = getDbInstance();

  if (model) {
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = 'pricing' AND key = ?")
      .get(provider);
    if (row) {
      const rowRecord = toRecord(row);
      const value = typeof rowRecord.value === "string" ? rowRecord.value : "{}";
      const models = toRecord(JSON.parse(value));
      delete models[model];
      if (Object.keys(models).length === 0) {
        db.prepare("DELETE FROM key_value WHERE namespace = 'pricing' AND key = ?").run(provider);
      } else {
        db.prepare("UPDATE key_value SET value = ? WHERE namespace = 'pricing' AND key = ?").run(
          JSON.stringify(models),
          provider
        );
      }
    }
  } else {
    db.prepare("DELETE FROM key_value WHERE namespace = 'pricing' AND key = ?").run(provider);
  }

  backupDbFile("pre-write");
  await touchPricing();
  const allRows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  const result: Record<string, unknown> = {};
  for (const row of allRows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    result[key] = JSON.parse(rawValue);
  }
  return result;
}

export async function resetAllPricing() {
  const db = getDbInstance();
  db.prepare("DELETE FROM key_value WHERE namespace = 'pricing'").run();
  backupDbFile("pre-write");
  await touchPricing();
  return {};
}
