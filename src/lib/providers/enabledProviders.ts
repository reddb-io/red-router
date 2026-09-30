/**
 * Provider enablement — the single definition of "is this provider available".
 *
 * RedRouter is opt-in: a provider is ENABLED only through an explicit operator
 * action —
 *   (a) it has at least one ACTIVE provider connection (any auth type), or
 *   (b) it works without a connection (no-auth / free-anonymous / anonymous
 *       fallback gateway) AND the operator listed it in `enabledNoAuthProviders`.
 * Nothing else (a provider merely being known, being local, being free) makes
 * a provider available. This module is pure and client-safe (no DB access);
 * server code reads settings/connections through ./enabledProvidersAccessor.
 */
import {
  AI_PROVIDERS,
  NOAUTH_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  LOCAL_PROVIDERS,
  SEARCH_PROVIDERS,
  AUDIO_ONLY_PROVIDERS,
  UPSTREAM_PROXY_PROVIDERS,
  CLOUD_AGENT_PROVIDERS,
  SYSTEM_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  getProviderById,
  getProviderByAlias,
} from "@/shared/constants/providers";
import { getNoAuthHydrationProviderIds } from "@/sse/services/noAuthProviderSiblings";

export type ProviderAvailabilityKind = "connected" | "free-optin" | "available";

export type EnabledProviderSettings = { enabledNoAuthProviders?: unknown } | null | undefined;

type ProviderDefLike = { id: string; noAuth?: boolean; anonymousFallback?: boolean };

/**
 * Keyless search/fetch endpoints. They are served anonymously by the search/fetch
 * registries (open-sse/config/searchRegistry.ts) rather than by provider connections,
 * so they are no-auth-capable too. `duckduckgo-free` has no entry in the dashboard
 * provider catalog, hence the explicit metadata.
 */
const KEYLESS_ENDPOINT_PROVIDERS: Record<string, { id: string; name: string; alias: string }> = {
  "duckduckgo-free": {
    id: "duckduckgo-free",
    name: "DuckDuckGo (free search)",
    alias: "duckduckgo",
  },
  context7: { id: "context7", name: "Context7 (library docs)", alias: "context7" },
};

let noAuthCapableIds: string[] | null = null;

/**
 * Ids of every provider that can be served WITHOUT a connection: the
 * NOAUTH_PROVIDERS registry plus any provider flagged `noAuth` or
 * `anonymousFallback` (opencode-zen/-go, kilocode, pollinations). These are the
 * only providers `enabledNoAuthProviders` can contain.
 */
export function listNoAuthProviderIds(): string[] {
  if (noAuthCapableIds) return noAuthCapableIds;
  const ids = new Set<string>(Object.keys(NOAUTH_PROVIDERS));
  for (const id of Object.keys(KEYLESS_ENDPOINT_PROVIDERS)) ids.add(id);
  for (const def of Object.values(AI_PROVIDERS) as ProviderDefLike[]) {
    if (def && (def.noAuth === true || def.anonymousFallback === true)) ids.add(def.id);
  }
  noAuthCapableIds = Array.from(ids);
  return noAuthCapableIds;
}

/**
 * The "free sources" the one-click enable-all switches on: every no-auth-capable
 * provider except local CLI bridges (Devin CLI, Auggie, ZCode, Codex app-server),
 * which are not anonymous free endpoints and stay individually opt-in.
 */
export function listFreeSourceProviderIds(): string[] {
  return listNoAuthProviderIds().filter(
    (id) => (getProviderById(id) as { isLocalCli?: boolean } | undefined)?.isLocalCli !== true
  );
}

/** Canonical registry id for an id or alias, or null when RedRouter does not know it. */
export function canonicalProviderIdOrNull(idOrAlias: unknown): string | null {
  if (typeof idOrAlias !== "string" || idOrAlias.length === 0) return null;
  if (getProviderById(idOrAlias) || KEYLESS_ENDPOINT_PROVIDERS[idOrAlias]) return idOrAlias;
  const keylessByAlias = Object.values(KEYLESS_ENDPOINT_PROVIDERS).find(
    (entry) => entry.alias === idOrAlias
  );
  if (keylessByAlias) return keylessByAlias.id;
  return getProviderByAlias(idOrAlias)?.id ?? null;
}

/** Display metadata for a no-auth-capable provider (registry entry or keyless endpoint). */
export function getNoAuthProviderInfo(id: string): { id: string; name: string; alias: string } {
  const keyless = KEYLESS_ENDPOINT_PROVIDERS[id];
  if (keyless) return keyless;
  const def = getProviderById(id) as { name?: string; alias?: string } | undefined;
  return { id, name: def?.name ?? id, alias: def?.alias ?? id };
}

/**
 * Normalise operator input to canonical, de-duplicated no-auth-capable
 * provider ids. Aliases are resolved; unknown ids and ids that need a
 * connection (keyed providers) are dropped.
 */
export function normalizeEnabledNoAuthProviders(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const capable = new Set(listNoAuthProviderIds());
  const out: string[] = [];
  for (const entry of input) {
    const canonical = canonicalProviderIdOrNull(typeof entry === "string" ? entry.trim() : entry);
    if (canonical && capable.has(canonical) && !out.includes(canonical)) out.push(canonical);
  }
  return out;
}

function enabledSet(settings: EnabledProviderSettings): Set<string> {
  return new Set(normalizeEnabledNoAuthProviders(settings?.enabledNoAuthProviders));
}

/** Pure check against an already-resolved enabled set. */
export function isNoAuthProviderInSet(idOrAlias: string, enabled: ReadonlySet<string>): boolean {
  const canonical = canonicalProviderIdOrNull(idOrAlias);
  if (!canonical || enabled.size === 0) return false;
  // Enabling "opencode" (OpenCode Free) also enables the gateways that serve
  // the same public endpoint (opencode-zen/-go) — see noAuthProviderSiblings.
  return getNoAuthHydrationProviderIds(canonical).some((id) => enabled.has(id));
}

/** True when the operator explicitly enabled this no-auth provider. */
export function isNoAuthProviderEnabled(
  idOrAlias: string,
  settings: EnabledProviderSettings
): boolean {
  return isNoAuthProviderInSet(idOrAlias, enabledSet(settings));
}

/** Whether a provider id (or alias) is servable without a connection. */
export function isNoAuthCapableProvider(idOrAlias: string): boolean {
  const canonical = canonicalProviderIdOrNull(idOrAlias);
  return canonical !== null && listNoAuthProviderIds().includes(canonical);
}

export function isProviderEnabled(input: {
  providerId: string;
  hasActiveConnection: boolean;
  settings: EnabledProviderSettings;
}): boolean {
  return input.hasActiveConnection || isNoAuthProviderEnabled(input.providerId, input.settings);
}

export function getProviderAvailabilityKind(input: {
  providerId: string;
  hasActiveConnection: boolean;
  settings: EnabledProviderSettings;
}): ProviderAvailabilityKind {
  if (input.hasActiveConnection) return "connected";
  return isNoAuthProviderEnabled(input.providerId, input.settings) ? "free-optin" : "available";
}

/**
 * ids + aliases of no-auth-capable providers that are NOT enabled and have no
 * active connection. Feeding this into a "blocked providers" set makes every
 * existing block check in the catalog/combo code treat them as absent.
 */
export function listNotEnabledNoAuthKeys(
  settings: EnabledProviderSettings,
  connectedProviderIds: Iterable<string>
): string[] {
  const enabled = enabledSet(settings);
  const connected = new Set<string>();
  for (const id of connectedProviderIds) {
    const canonical = canonicalProviderIdOrNull(id) ?? id;
    connected.add(canonical);
  }
  const keys: string[] = [];
  for (const id of listNoAuthProviderIds()) {
    if (connected.has(id) || isNoAuthProviderInSet(id, enabled)) continue;
    keys.push(id);
    const alias = getNoAuthProviderInfo(id).alias;
    if (alias !== id) keys.push(alias);
  }
  return keys;
}

export type ProviderSection =
  | "no-auth"
  | "oauth"
  | "apikey"
  | "web-cookie"
  | "local"
  | "search"
  | "audio"
  | "upstream-proxy"
  | "cloud-agent"
  | "system"
  | "compatible-node"
  | "unknown";

/** Which registry section a provider belongs to (for reporting/UI grouping). */
export function getProviderSection(idOrAlias: string): ProviderSection {
  const id = canonicalProviderIdOrNull(idOrAlias);
  if (!id) return /^(openai|anthropic)-compatible-/.test(idOrAlias) ? "compatible-node" : "unknown";
  const has = (section: object) => Object.prototype.hasOwnProperty.call(section, id);
  if (has(NOAUTH_PROVIDERS)) return "no-auth";
  if (has(OAUTH_PROVIDERS)) return "oauth";
  if (has(APIKEY_PROVIDERS)) return "apikey";
  if (has(WEB_COOKIE_PROVIDERS)) return "web-cookie";
  if (has(LOCAL_PROVIDERS)) return "local";
  if (has(SEARCH_PROVIDERS)) return "search";
  if (has(AUDIO_ONLY_PROVIDERS)) return "audio";
  if (has(UPSTREAM_PROXY_PROVIDERS)) return "upstream-proxy";
  if (has(CLOUD_AGENT_PROVIDERS)) return "cloud-agent";
  if (has(SYSTEM_PROVIDERS)) return "system";
  return "unknown";
}
