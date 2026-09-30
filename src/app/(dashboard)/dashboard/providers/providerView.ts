import {
  AGGREGATOR_PROVIDER_IDS,
  EMBEDDING_RERANK_PROVIDER_IDS,
  ENTERPRISE_CLOUD_PROVIDER_IDS,
  IDE_PROVIDER_IDS,
  IMAGE_ONLY_PROVIDER_IDS,
  VIDEO_PROVIDER_IDS,
} from "@/shared/constants/providers";
import type { ProviderView } from "./providerPageStorage";
import type { ProviderEntry } from "./providerPageUtils";

/**
 * Pure helpers behind the providers page views. RedRouter is opt-in: a provider is "enabled"
 * when it has an active connection or, for keyless sources, the operator turned it on
 * (`GET /api/providers` -> `providerAvailability`, see src/lib/providers/enabledProviders.ts).
 * The page opens on the enabled slice; everything else is reachable but never listed by default.
 */

export type ProviderAvailabilityKind = "connected" | "free-optin" | "available";

export interface ProviderAvailabilityEntry {
  enabled: boolean;
  kind: ProviderAvailabilityKind;
}

export type ProviderAvailabilityMap = Record<string, ProviderAvailabilityEntry>;

type ViewEntry = Pick<ProviderEntry, "providerId" | "displayAuthType" | "stats">;

/** Shape-check the `providerAvailability` payload; anything else means "unknown". */
export function normalizeProviderAvailability(value: unknown): ProviderAvailabilityMap | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: ProviderAvailabilityMap = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const { enabled, kind } = raw as { enabled?: unknown; kind?: unknown };
    if (typeof enabled !== "boolean") continue;
    out[id] = {
      enabled,
      kind: kind === "connected" || kind === "free-optin" ? kind : "available",
    };
  }
  return out;
}

/**
 * Whether an entry belongs in the "Enabled" slice.
 *
 * - `providerAvailability[id].enabled` is authoritative (active connection or an enabled free source).
 * - A provider that still has saved connections stays listed even when every one is switched off,
 *   so the operator can switch it back on from its card instead of hunting for it in "All".
 * - Compatible providers are nodes the operator created by hand, so they are always listed.
 * - Keyless sources without an explicit opt-in are never enabled, whatever else is true of them.
 */
export function isProviderEntryEnabled(
  entry: ViewEntry,
  availability: ProviderAvailabilityMap | null | undefined
): boolean {
  // The server decides: enabled = an ACTIVE connection, or a free source the operator switched on.
  // A provider whose connections are all switched off is not enabled (it stays reachable from
  // "All providers" → Manage). Only when availability has not loaded do we fall back to counts.
  const known = availability?.[entry.providerId];
  if (known) return known.enabled === true;
  if (entry.displayAuthType === "compatible") return true;
  return Number(entry.stats?.total || 0) > 0;
}

/**
 * Restrict entries to a view. "enabled" keeps only enabled providers, "free" keeps keyless
 * (no-auth) sources, "all" is the whole catalogue.
 */
export function filterProviderEntriesByView<T extends ViewEntry>(
  entries: T[],
  view: ProviderView,
  availability: ProviderAvailabilityMap | null | undefined
): T[] {
  if (view === "all") return entries;
  if (view === "free") return entries.filter((entry) => entry.displayAuthType === "no-auth");
  return entries.filter((entry) => isProviderEntryEnabled(entry, availability));
}

export function countEnabledProviderEntries(
  entries: ViewEntry[],
  availability: ProviderAvailabilityMap | null | undefined
): number {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (isProviderEntryEnabled(entry, availability)) seen.add(entry.providerId);
  }
  return seen.size;
}

// ── "All providers" catalogue metadata ────────────────────────────────────────

export interface ProviderCatalogueMeta {
  categoryKey: string;
  categoryLabel: string;
  authKey: "oauth" | "apikey" | "none" | "session" | "local";
  authLabel: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  ide: "IDE",
  aggregator: "Aggregator",
  enterprise: "Enterprise and cloud",
  embedding: "Embeddings and rerank",
  image: "Image",
  video: "Video",
  search: "Search",
  audio: "Audio",
  local: "Local",
  "cloud-agent": "Cloud agent",
  "upstream-proxy": "Upstream proxy",
  "web-cookie": "Web session",
  compatible: "Compatible",
  "no-auth": "Free source",
  oauth: "Subscription",
  apikey: "LLM",
};

const AUTH_LABELS: Record<ProviderCatalogueMeta["authKey"], string> = {
  oauth: "OAuth",
  apikey: "API key",
  none: "No key",
  session: "Web session",
  local: "No key",
};

/**
 * Category and auth type for one catalogue row. `resolvedCategory` is the catalog category from
 * `resolveDashboardProviderInfo(id)?.category` when known.
 */
export function getProviderCatalogueMeta(
  entry: Pick<ProviderEntry, "providerId" | "displayAuthType">,
  resolvedCategory?: string | null
): ProviderCatalogueMeta {
  const id = entry.providerId;
  let categoryKey: string;
  if (entry.displayAuthType === "compatible" || resolvedCategory === "compatible") {
    categoryKey = "compatible";
  } else if (IDE_PROVIDER_IDS.has(id)) categoryKey = "ide";
  else if (AGGREGATOR_PROVIDER_IDS.has(id)) categoryKey = "aggregator";
  else if (ENTERPRISE_CLOUD_PROVIDER_IDS.has(id)) categoryKey = "enterprise";
  else if (EMBEDDING_RERANK_PROVIDER_IDS.has(id)) categoryKey = "embedding";
  else if (IMAGE_ONLY_PROVIDER_IDS.has(id)) categoryKey = "image";
  else if (VIDEO_PROVIDER_IDS.has(id)) categoryKey = "video";
  else categoryKey = resolvedCategory || entry.displayAuthType || "apikey";

  let authKey: ProviderCatalogueMeta["authKey"];
  if (categoryKey === "no-auth" || entry.displayAuthType === "no-auth") authKey = "none";
  else if (categoryKey === "web-cookie") authKey = "session";
  else if (categoryKey === "local") authKey = "local";
  else if (entry.displayAuthType === "oauth" || categoryKey === "oauth") authKey = "oauth";
  else authKey = "apikey";

  return {
    categoryKey,
    categoryLabel: CATEGORY_LABELS[categoryKey] ?? CATEGORY_LABELS.apikey,
    authKey,
    authLabel: AUTH_LABELS[authKey],
  };
}
