#!/usr/bin/env node
// Refresh the model catalogs vendored in src/lib/modelCatalog/snapshot/, so the
// dashboard's model browser and limits work offline and before the first sync:
//   api.json, models.json — models.dev (anomalyco/models.dev), every model type
//   openrouter.json       — OpenRouter's /models, every output modality, slimmed
//   canonical-map.json    — which canonical model ("vendor/model") each provider
//                           offer serves, from the models.dev repository
// Run before a release: `node scripts/refresh-catalog-snapshots.mjs` (needs git).
import { writeFileSync, renameSync, mkdtempSync, rmSync, readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { slimOpenRouterModel } from "../src/lib/modelCatalog/browseShape.js";
import { buildCanonicalMap } from "../src/lib/modelCatalog/canonicalBuild.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/lib/modelCatalog/snapshot");
const MODELS_DEV_REPO = "https://github.com/anomalyco/models.dev.git";

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

/** Every *.toml under `root`, as path-style ids ("openai/gpt-5"); broken links are skipped. */
function tomlIds(root, onFile) {
  const walk = (d, prefix) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try { isDir = statSync(path).isDirectory(); } catch { continue; }
      }
      if (isDir) walk(path, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".toml")) onFile(`${prefix}${entry.name.slice(0, -5)}`, path);
    }
  };
  walk(root, "");
}

/**
 * Clone models.dev (shallow) and read the links its generated JSON leaves out:
 * models/ is the canonical tree, providers/<p>/models/*.toml carry base_model.
 */
function readModelsDevRepo() {
  const work = mkdtempSync(join(tmpdir(), "models-dev-"));
  try {
    execFileSync("git", ["clone", "--quiet", "--depth", "1", MODELS_DEV_REPO, work], { stdio: "inherit" });
    const commit = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const canonicalIds = [];
    tomlIds(join(work, "models"), (id) => canonicalIds.push(id));
    const offers = [];
    for (const provider of readdirSync(join(work, "providers"))) {
      const modelsDir = join(work, "providers", provider, "models");
      if (!existsSync(modelsDir)) continue;
      tomlIds(modelsDir, (id, path) => {
        let text;
        try { text = readFileSync(path, "utf8"); } catch { return; }
        const baseModel = text.match(/^base_model\s*=\s*"([^"]+)"/m)?.[1] || null;
        offers.push({ provider, id, baseModel });
      });
    }
    return { canonicalIds, offers, source: { repo: "anomalyco/models.dev", commit } };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const [api, models, openrouter] = await Promise.all([
  // type=all: decision models (TypeSafe's JEV) are left out without it.
  getJson("https://models.dev/api.json?type=all"),
  getJson("https://models.dev/models.json?type=all"),
  getJson("https://openrouter.ai/api/v1/models?output_modalities=all"),
]);
if (!Array.isArray(openrouter?.data) || !openrouter.data.length) throw new Error("OpenRouter returned no models");
const canonicalMap = buildCanonicalMap(readModelsDevRepo());

write("api.json", api);
write("models.json", models);
write("openrouter.json", { fetchedAt: new Date().toISOString(), models: openrouter.data.map(slimOpenRouterModel) });
write("canonical-map.json", canonicalMap);

const count = (m) => Object.values(m).reduce((n, p) => n + Object.keys(p).length, 0);
console.log(`models.dev: ${Object.keys(api).length} providers; OpenRouter: ${openrouter.data.length} models`);
console.log(`canonical map: ${canonicalMap.models.length} models, ${count(canonicalMap.offers)} stated + ${count(canonicalMap.inferred)} inferred offer links (models.dev ${canonicalMap.source.commit.slice(0, 7)})`);
