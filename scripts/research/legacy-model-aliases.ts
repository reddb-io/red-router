// Snapshot the legacy registry's permission aliases, not transport capabilities.
// Regenerate only after reviewing model-permission compatibility against the baseline.
import { writeFileSync } from "node:fs";
import {
  AI_PROVIDERS,
  getProviderAlias,
  resolveProviderId,
} from "../../src/shared/constants/providers";
import { PROVIDER_COMPATIBILITY_ALIASES } from "../../src/shared/constants/providerCompatibilityAliases";

const inputs = new Set(Object.keys(PROVIDER_COMPATIBILITY_ALIASES));
for (const provider of Object.values(AI_PROVIDERS)) {
  inputs.add(provider.id);
  inputs.add(provider.alias);
}
const aliases = Object.fromEntries(
  [...inputs].sort().map((input) => {
    const id = resolveProviderId(input);
    return [input, [id, getProviderAlias(id)]];
  })
);
writeFileSync(
  "rust/red-routerd/src/legacy_model_aliases.json",
  JSON.stringify(
    {
      source_commit: "525a71de4ac25968d0a25e52eeb1b09cc21c6e92",
      aliases,
    },
    null,
    2
  ) + "\n"
);
