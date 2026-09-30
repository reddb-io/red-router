/**
 * Server-side accessors for provider enablement (see ./enabledProviders).
 *
 * Settings come from the shared settings read cache, which is invalidated on
 * every settings write (`invalidateDbCache("settings")`). The derived Set is
 * memoised against the identity of that cached settings object (so it is
 * recomputed as soon as settings change) and additionally capped at 2 s.
 */
import { getCachedSettings, getCachedRawProviderConnections } from "@/lib/db/readCache";
import { getNoAuthHydrationProviderIds } from "@/sse/services/noAuthProviderSiblings";
import {
  canonicalProviderIdOrNull,
  isNoAuthCapableProvider,
  isNoAuthProviderInSet,
  normalizeEnabledNoAuthProviders,
  type ProviderAvailabilityKind,
} from "./enabledProviders";

const SET_TTL_MS = 2000;

let memo: { source: unknown; expiresAt: number; value: Set<string> } | null = null;

export function invalidateEnabledProvidersCache(): void {
  memo = null;
}

export async function getEnabledNoAuthProviderSet(): Promise<Set<string>> {
  const settings = await getCachedSettings();
  const now = Date.now();
  if (memo && memo.source === settings && now < memo.expiresAt) return memo.value;
  const value = new Set(normalizeEnabledNoAuthProviders(settings?.enabledNoAuthProviders));
  memo = { source: settings, expiresAt: now + SET_TTL_MS, value };
  return value;
}

/** True when at least one ACTIVE connection exists for the provider (or a same-endpoint sibling). */
export async function hasActiveProviderConnection(providerId: string): Promise<boolean> {
  const canonical = canonicalProviderIdOrNull(providerId) ?? providerId;
  for (const id of getNoAuthHydrationProviderIds(canonical)) {
    const rows = await getCachedRawProviderConnections({ provider: id, isActive: true });
    if (Array.isArray(rows) && rows.length > 0) return true;
  }
  return false;
}

/** Explicitly enabled in `enabledNoAuthProviders` (no connection check). */
export async function isNoAuthProviderEnabledNow(providerId: string): Promise<boolean> {
  return isNoAuthProviderInSet(providerId, await getEnabledNoAuthProviderSet());
}

/** Enabled = active connection OR explicitly enabled no-auth provider. */
export async function isProviderEnabledNow(providerId: string): Promise<boolean> {
  if (await isNoAuthProviderEnabledNow(providerId)) return true;
  return hasActiveProviderConnection(providerId);
}

export async function getProviderAvailabilityKindNow(
  providerId: string
): Promise<ProviderAvailabilityKind> {
  if (await hasActiveProviderConnection(providerId)) return "connected";
  return (await isNoAuthProviderEnabledNow(providerId)) ? "free-optin" : "available";
}

/**
 * Gate for keyless endpoints (anonymous search/fetch tiers): providers that need a connection
 * are not affected (true); a no-auth-capable one passes only when enabled or connected.
 */
export async function isNoAuthGateOpenNow(providerId: string): Promise<boolean> {
  if (!isNoAuthCapableProvider(providerId)) return true;
  return isProviderEnabledNow(providerId);
}
