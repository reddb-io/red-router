// Read side of the model catalog synced from models.dev.
//
// The file is the source of truth; the only thing held in memory is a parsed
// copy dropped as soon as the file's mtime changes. getCapabilitiesForModel is
// synchronous and runs per request, so the hot path is one stat (~1us) and the
// parse (~0.1ms on a ~18KB file) only reruns after a sync.

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

export const CATALOG_FILE = path.join(DATA_DIR, "model-catalog.json");
// Trimmed upstream catalog, read by the add-models skill (not by the router).
export const CATALOG_RAW_FILE = path.join(DATA_DIR, "model-catalog-raw.json");
// Per-provider browse catalog (names, dates, prices, capabilities) for the
// dashboard's model browser. Written by the same sync; read by src/lib/modelCatalog/browse.js.
export const CATALOG_BROWSE_FILE = path.join(DATA_DIR, "model-catalog-browse.json");
// Last good OpenRouter /models list, so its browser works offline and after a
// restart without network. Written by src/lib/modelCatalog/browse.js.
export const OPENROUTER_CATALOG_FILE = path.join(DATA_DIR, "model-catalog-openrouter.json");
// 3: the browse file keeps each model's serving SDK (`a`); bumping it makes the
// next sync download the catalog in full instead of trusting its etag.
export const CATALOG_VERSION = 3;

const EMPTY = { models: {}, providers: {}, modelLimits: {} };
let cache = EMPTY;
let cachedMtime = -1;

// "zai-org/GLM-4.6V:free" -> "glm-4.6v"
function baseId(model) {
  if (!model) return "";
  const withoutVendor = model.includes("/") ? model.split("/").pop() : model;
  return withoutVendor.toLowerCase().split(":")[0];
}

function load() {
  let mtime;
  try {
    mtime = fs.statSync(CATALOG_FILE).mtimeMs;
  } catch {
    cache = EMPTY;
    cachedMtime = -1;
    return cache;
  }
  if (mtime === cachedMtime) return cache;

  cachedMtime = mtime;
  try {
    const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
    cache = { models: parsed?.models || {}, providers: parsed?.providers || {}, modelLimits: parsed?.modelLimits || {} };
  } catch {
    cache = EMPTY;
  }
  return cache;
}

// Gateways can expose different modalities for the same model weights.
export function getCatalogModalities(provider, model) {
  if (!provider) return null;
  return load().models[`${provider}:${baseId(model)}`] || null;
}

// Context and output limits are a property of the gateway, not the model: each
// one truncates differently, so these stay keyed by provider + model.
export function getCatalogLimits(provider, model) {
  const byProvider = provider && load().providers[provider];
  if (!byProvider) return null;
  return byProvider[model] || byProvider[baseId(model)] || null;
}

// Model-agnostic fallback limits from models.dev/models.json, used when the
// gateway's own numbers are missing (unaliased compatible providers, custom
// connections). The model is still the model, whoever serves it.
export function getModelLimits(model) {
  const limits = load().modelLimits;
  if (!limits) return null;
  return limits[model.toLowerCase()] || limits[baseId(model)] || null;
}

// Force a re-read on the next lookup (called right after a sync writes the file).
export function invalidateCatalog() {
  cachedMtime = -1;
}

// Hand the reader to capabilities.js. That module is bundled into the browser
// too, so it cannot import this file directly — the server pushes it in.
export async function installCatalogSource() {
  const { setCatalogSource } = await import("./capabilities.js");
  setCatalogSource({ getModalities: getCatalogModalities, getLimits: getCatalogLimits, getLimitsByModel: getModelLimits });
}
