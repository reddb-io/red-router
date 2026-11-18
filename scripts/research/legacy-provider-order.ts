// Snapshot the legacy catalog's provider precedence for the Rust `/v1/models`
// ordering (rust/red-routerd/src/catalog_order.rs). Regenerate whenever the
// legacy provider constants change; the Rust tests pin the registry order.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { OAUTH_PROVIDERS } from "../../src/shared/constants/providers/oauth";
import { NOAUTH_PROVIDERS } from "../../src/shared/constants/providers/noauth";
import { APIKEY_PROVIDERS } from "../../src/shared/constants/providers/apikey";
import {
  CANONICAL_PROVIDER_ORDER,
  providerRank,
} from "../../src/shared/constants/canonicalProviderOrder";

// Aliases share their provider's rank unless they are themselves canonical ids.
// providerRank resolves through the legacy map, so a shared alias keeps the
// provider the legacy catalog picks.
const canonical = new Set(CANONICAL_PROVIDER_ORDER);
const aliases: Record<string, string> = {};
const definitions = Object.values({
  ...OAUTH_PROVIDERS,
  ...NOAUTH_PROVIDERS,
  ...APIKEY_PROVIDERS,
}) as Array<{ alias?: unknown }>;
for (const { alias } of definitions) {
  if (typeof alias !== "string" || alias.length === 0 || canonical.has(alias)) continue;
  const rank = providerRank(alias);
  if (rank < CANONICAL_PROVIDER_ORDER.length) aliases[alias] = CANONICAL_PROVIDER_ORDER[rank];
}

const sourceCommit = execFileSync(
  "git",
  [
    "log",
    "-1",
    "--format=%H",
    "--",
    "src/shared/constants/canonicalProviderOrder.ts",
    "src/shared/constants/providers/oauth.ts",
    "src/shared/constants/providers/noauth.ts",
    "src/shared/constants/providers/apikey",
  ],
  { encoding: "utf8" }
).trim();

writeFileSync(
  "rust/red-routerd/src/legacy_provider_order.json",
  JSON.stringify(
    {
      source_commit: sourceCommit,
      order: CANONICAL_PROVIDER_ORDER,
      aliases: Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => (a < b ? -1 : 1))),
    },
    null,
    2
  ) + "\n"
);
