/** Explicit, reviewable catalog update. Builds and installation never fetch this feed. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const CATALOG_URL = "https://models.dev/catalog.json?type=all";
const DEFAULT_SCHEMA_REF = "592a849d85d184cad180803a60ecaa0a521f96b9";
const OUTPUT = fileURLToPath(new URL("../../src/lib/catalog/modelsDevSeed.json", import.meta.url));
const strings = [
  "name",
  "family",
  "knowledge",
  "release_date",
  "last_updated",
  "status",
  "canonical_model_id",
];
const flags = [
  "attachment",
  "reasoning",
  "tool_call",
  "structured_output",
  "temperature",
  "open_weights",
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const sorted = (value) => Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

function identifier(value) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 1024 ||
    /[\x00-\x1f]/.test(value)
  ) {
    throw new Error("Catalog contains an invalid identifier");
  }
  return value;
}

function normalizeModel(value, id) {
  if (!record(value)) throw new Error("Catalog contains an invalid model");
  if (value.id !== undefined && value.id !== id)
    throw new Error("Model key and native ID disagree");
  const result = { id: identifier(id) };
  for (const key of strings) {
    if (typeof value[key] === "string") result[key] = value[key];
  }
  for (const key of flags) {
    if (typeof value[key] === "boolean") result[key] = value[key];
  }
  if (typeof value.type === "string") result.type = value.type;
  if (record(value.modalities)) {
    result.modalities = {};
    for (const direction of ["input", "output"]) {
      if (Array.isArray(value.modalities[direction])) {
        result.modalities[direction] = value.modalities[direction].filter(
          (item) => typeof item === "string"
        );
      }
    }
  }
  for (const [key, allowed] of [
    ["limit", ["context", "input", "output"]],
    [
      "cost",
      ["input", "output", "reasoning", "cache_read", "cache_write", "input_audio", "output_audio"],
    ],
  ]) {
    if (!record(value[key])) continue;
    result[key] = {};
    for (const field of allowed) {
      const number = value[key][field];
      if (number === undefined) continue;
      if (typeof number !== "number" || !Number.isFinite(number) || number < 0) {
        throw new Error("Catalog contains an invalid cost or limit");
      }
      result[key][field] = number;
    }
  }
  if (typeof value.interleaved === "boolean") result.interleaved = value.interleaved;
  else if (record(value.interleaved) && typeof value.interleaved.field === "string") {
    result.interleaved = { field: value.interleaved.field };
  }
  if (Array.isArray(value.reasoning_options)) {
    result.reasoning_options = value.reasoning_options.map((option) => {
      if (!record(option)) throw new Error("Invalid reasoning option");
      if (option.type === "toggle") return { type: "toggle" };
      if (
        option.type === "effort" &&
        Array.isArray(option.values) &&
        option.values.every((item) => item === null || typeof item === "string")
      ) {
        return { type: "effort", values: option.values };
      }
      if (option.type === "budget_tokens") {
        const normalized = { type: "budget_tokens" };
        for (const field of ["min", "max"]) {
          if (option[field] === undefined) continue;
          if (
            typeof option[field] !== "number" ||
            !Number.isFinite(option[field]) ||
            option[field] < (field === "min" ? -1 : 0)
          ) {
            throw new Error("Invalid reasoning budget");
          }
          normalized[field] = option[field];
        }
        if (
          normalized.min !== undefined &&
          normalized.max !== undefined &&
          normalized.min > normalized.max
        ) {
          throw new Error("Invalid reasoning budget range");
        }
        return normalized;
      }
      throw new Error("Unknown reasoning option; review the upstream schema before importing");
    });
  }
  return result;
}

export function normalizeCatalog(raw) {
  if (!record(raw?.providers) || !record(raw?.models))
    throw new Error("Expected providers and canonical models");
  const providers = Object.fromEntries(
    sorted(raw.providers).map(([id, value]) => {
      identifier(id);
      if (!record(value) || value.id !== id || !record(value.models))
        throw new Error("Invalid provider identity");
      const models = Object.fromEntries(
        sorted(value.models).map(([modelId, model]) => [modelId, normalizeModel(model, modelId)])
      );
      return [id, { id, name: typeof value.name === "string" ? value.name : id, models }];
    })
  );
  const models = Object.fromEntries(
    sorted(raw.models).map(([id, value]) => [id, normalizeModel(value, id)])
  );
  if (
    !Object.keys(providers).length ||
    !Object.values(providers).some((provider) => Object.keys(provider.models).length)
  ) {
    throw new Error("Refusing an empty catalog snapshot");
  }
  return { providers, models };
}

async function main() {
  const args = process.argv.slice(2);
  const options = Object.create(null);
  for (let index = 0; index < args.length; index += 2) {
    if (
      !["--input", "--fetched-at", "--schema-ref", "--etag"].includes(args[index]) ||
      !args[index + 1]
    ) {
      throw new Error(
        "Usage: update-models-dev-seed.mjs [--input catalog.json] [--fetched-at ISO_DATE] [--schema-ref SHA] [--etag ETAG]"
      );
    }
    options[args[index]] = args[index + 1];
  }
  let body;
  let etag = null;
  if (options["--input"]) body = await readFile(options["--input"], "utf8");
  else {
    const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Catalog fetch failed (${response.status})`);
    body = await response.text();
    etag = response.headers.get("etag");
  }
  etag = options["--etag"] || etag;
  if (Buffer.byteLength(body) > 16 * 1024 * 1024)
    throw new Error("Catalog exceeds snapshot size limit");
  const catalog = normalizeCatalog(JSON.parse(body));
  const fetchedAt = options["--fetched-at"] || new Date().toISOString();
  if (!Number.isFinite(Date.parse(fetchedAt))) throw new Error("Invalid fetch timestamp");
  const schemaRef = options["--schema-ref"] || DEFAULT_SCHEMA_REF;
  if (!/^[a-f0-9]{40}$/.test(schemaRef)) throw new Error("Invalid upstream schema ref");
  const manifest = {
    schemaVersion: 1,
    transformVersion: 2,
    source: CATALOG_URL,
    upstreamRepository: "https://github.com/anomalyco/models.dev",
    upstreamSchemaRef: schemaRef,
    fetchedAt,
    etag,
    sourceSha256: sha256(body),
    contentSha256: sha256(JSON.stringify(catalog)),
    license: "MIT",
    providers: Object.keys(catalog.providers).length,
    providerModels: Object.values(catalog.providers).reduce(
      (count, provider) => count + Object.keys(provider.models).length,
      0
    ),
    canonicalModels: Object.keys(catalog.models).length,
  };
  await writeFile(OUTPUT, JSON.stringify({ manifest, ...catalog }) + "\n");
  process.stdout.write(
    `Catalog snapshot saved: ${manifest.providers} providers, ${manifest.providerModels} offerings; ${manifest.contentSha256}\n`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
