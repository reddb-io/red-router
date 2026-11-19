// Snapshot the legacy static model -> provider index (`MODEL_TO_PROVIDERS` in
// open-sse/services/model.ts) for the Rust provider inference
// (rust/red-routerd/src/legacy_model_index.rs). Regenerate whenever the
// provider registry changes. Provider order inside each entry is the legacy
// registry iteration order, which the inference relies on.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { PROVIDER_ID_TO_ALIAS, PROVIDER_MODELS } from "../../open-sse/config/providerModels";
import { ALIAS_TO_PROVIDER_ID, resolveProviderAlias } from "../../open-sse/services/providerAlias";

const index = new Map<string, string[]>();
for (const [aliasOrId, models] of Object.entries(PROVIDER_MODELS)) {
  const providerId = ALIAS_TO_PROVIDER_ID[aliasOrId] || aliasOrId;
  for (const entry of models || []) {
    const modelId = entry?.id;
    if (!modelId) continue;
    const providers = index.get(modelId) || [];
    if (!providers.includes(providerId)) {
      providers.push(providerId);
      index.set(modelId, providers);
    }
  }
}

const sourceCommit = execFileSync(
  "git",
  [
    "log",
    "-1",
    "--format=%H",
    "--",
    "open-sse/config/providers",
    "open-sse/config/providerModels.ts",
    "open-sse/config/providerRegistry.ts",
    "open-sse/services/providerAlias.ts",
  ],
  { encoding: "utf8" }
).trim();

// Pairs keep model ids that look like integers in place; JSON objects would
// reorder them.
const models = [...index.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
// The inference canonicalizes candidates with resolveProviderAlias (e.g.
// "opencode" -> "opencode-zen") and names them by their display alias in
// ambiguity hints; record both for every indexed provider where they differ.
const indexed = [...new Set(models.flatMap(([, providers]) => providers))].sort();
const canonical: Record<string, string> = {};
const hints: Record<string, string> = {};
for (const provider of indexed) {
  const resolved = resolveProviderAlias(provider);
  if (typeof resolved === "string" && resolved !== provider) canonical[provider] = resolved;
  const alias = PROVIDER_ID_TO_ALIAS[provider];
  if (typeof alias === "string" && alias !== provider) hints[provider] = alias;
}

// One entry per line keeps regenerated diffs readable.
const lines = models.map((entry) => `    ${JSON.stringify(entry)}`).join(",\n");
writeFileSync(
  "rust/red-routerd/src/legacy_model_providers.json",
  `{\n  "source_commit": ${JSON.stringify(sourceCommit)},\n` +
    `  "canonical": ${JSON.stringify(canonical)},\n` +
    `  "hint_aliases": ${JSON.stringify(hints)},\n` +
    `  "models": [\n${lines}\n  ]\n}\n`
);
console.log(`${models.length} models`);
