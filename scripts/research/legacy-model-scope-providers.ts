// Snapshot the providers the legacy `hasPerModelQuota` (open-sse/services/
// accountFallback.ts) treats as multiplexing independently limited models
// behind one credential, for the Rust automatic failure scope
// (rust/red-routerd/src/model_scope_providers.rs). It mirrors the static
// branches of hasPerModelQuota: Antigravity/agy, Codex, Gemini and GitHub,
// passthrough providers of either registry, local and self-hosted providers.
// Compatible ids (`openai-compatible-*`, `anthropic-compatible-*`) are matched
// by prefix in Rust. Regenerate whenever a provider registry changes.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { getPassthroughProviders } from "../../open-sse/config/providerRegistry";
import { SELF_HOSTED_CHAT_PROVIDER_IDS } from "../../src/shared/constants/providers";
import { NOAUTH_PROVIDERS } from "../../src/shared/constants/providers/noauth";
import { OAUTH_PROVIDERS } from "../../src/shared/constants/providers/oauth";
import { WEB_COOKIE_PROVIDERS } from "../../src/shared/constants/providers/web-cookie";
import { APIKEY_PROVIDERS } from "../../src/shared/constants/providers/apikey";
import { LOCAL_PROVIDERS } from "../../src/shared/constants/providers/local";
import { SEARCH_PROVIDERS } from "../../src/shared/constants/providers/search";
import { AUDIO_ONLY_PROVIDERS } from "../../src/shared/constants/providers/audio";
import { UPSTREAM_PROXY_PROVIDERS } from "../../src/shared/constants/providers/upstream-proxy";
import { CLOUD_AGENT_PROVIDERS } from "../../src/shared/constants/providers/cloud-agent";
import { SYSTEM_PROVIDERS } from "../../src/shared/constants/providers/system";

type Definition = { id?: string; alias?: string; passthroughModels?: boolean };
// The sections getProviderById consults, in its order.
const sections = [
  NOAUTH_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  LOCAL_PROVIDERS,
  SEARCH_PROVIDERS,
  AUDIO_ONLY_PROVIDERS,
  UPSTREAM_PROXY_PROVIDERS,
  CLOUD_AGENT_PROVIDERS,
  SYSTEM_PROVIDERS,
] as Record<string, Definition>[];
const byId = (id: string): Definition | undefined =>
  sections.map((section) => section[id]).find((entry) => entry !== undefined);

const scoped = new Set<string>(["antigravity", "agy", "codex", "gemini", "github"]);
for (const id of getPassthroughProviders()) scoped.add(id);
for (const section of sections) {
  for (const id of Object.keys(section)) {
    if (byId(id)?.passthroughModels === true) scoped.add(id);
  }
}
for (const id of Object.keys(LOCAL_PROVIDERS)) scoped.add(id);
for (const id of SELF_HOSTED_CHAT_PROVIDER_IDS) scoped.add(id);

// The legacy check canonicalizes an alias to its provider id first; record
// each alias of a scoped id so the Rust lookup needs no alias table.
const aliases: Record<string, string> = {};
for (const section of sections) {
  for (const entry of Object.values(section)) {
    const { id, alias } = entry ?? {};
    if (id && alias && alias !== id && scoped.has(id) && !scoped.has(alias)) aliases[alias] = id;
  }
}

const sourceCommit = execFileSync(
  "git",
  [
    "log",
    "-1",
    "--format=%H",
    "--",
    "open-sse/config",
    "open-sse/services/accountFallback.ts",
    "src/shared/constants/providers.ts",
    "src/shared/constants/providers",
  ],
  { encoding: "utf8" }
).trim();

const providers = [...scoped].sort();
writeFileSync(
  "rust/red-routerd/src/legacy_model_scope_providers.json",
  `{\n  "source_commit": ${JSON.stringify(sourceCommit)},\n` +
    `  "aliases": ${JSON.stringify(aliases)},\n` +
    `  "providers": [\n${providers.map((id) => `    ${JSON.stringify(id)}`).join(",\n")}\n  ]\n}\n`
);
console.log(`${providers.length} providers, ${Object.keys(aliases).length} aliases`);
