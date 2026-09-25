#!/usr/bin/env node
// Refresh the model catalogs vendored in src/lib/modelCatalog/snapshot/, so the
// dashboard's model browser and limits work offline and before the first sync:
//   api.json, models.json — models.dev (anomalyco/models.dev), as published
//   openrouter.json       — OpenRouter's /models, every output modality, slimmed
// Run before a release: `node scripts/refresh-catalog-snapshots.mjs`.
import { writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { slimOpenRouterModel } from "../src/lib/modelCatalog/browseShape.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/lib/modelCatalog/snapshot");

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function write(name, value) {
  const target = join(dir, name);
  writeFileSync(`${target}.tmp`, JSON.stringify(value));
  renameSync(`${target}.tmp`, target);
}

const [api, models, openrouter] = await Promise.all([
  getJson("https://models.dev/api.json"),
  getJson("https://models.dev/models.json"),
  getJson("https://openrouter.ai/api/v1/models?output_modalities=all"),
]);
if (!Array.isArray(openrouter?.data) || !openrouter.data.length) throw new Error("OpenRouter returned no models");

write("api.json", api);
write("models.json", models);
write("openrouter.json", { fetchedAt: new Date().toISOString(), models: openrouter.data.map(slimOpenRouterModel) });
console.log(`models.dev: ${Object.keys(api).length} providers; OpenRouter: ${openrouter.data.length} models`);
