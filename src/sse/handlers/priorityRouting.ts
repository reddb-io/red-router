/**
 * Non-transparent model visibility, request side.
 *
 * When the effective policy hides providers, the catalog lists bare model names (see
 * lib/routing/bareModels.ts) and a request for one is routed here: the providers that offer the model
 * — for THIS key, exactly as its /v1/models shows them — are tried in the owner's (or the delegated
 * tenant admin's) priority order, falling through to the next on failure. A provider prefix on the
 * request is ignored: `openai/gpt-4o` and `gpt-4o` are the same request.
 *
 * It is built as a priority combo, so the existing fallback, breaker, budget and quota machinery
 * applies unchanged.
 */

import { getUnifiedModelsResponse } from "@/app/api/v1/models/catalog";
import { markTransparentCatalogRequest } from "@/app/api/v1/models/catalogTransparency";
import { buildAliasMaps } from "@/app/api/v1/models/catalogProviderMaps";
import { bareKey, orderedTargetsFor, type CatalogEntry } from "@/lib/routing/bareModels";
import { resolveRoutingPolicy } from "@/lib/routing/routingPolicy";
import { RED_ROUTER_CATALOG_VERSION_HEADER } from "@/shared/constants/redRouterHeaders";
import { fingerprintCatalogAuthKey } from "@/app/api/v1/models/catalogCache";

interface CachedIndex {
  version: string;
  models: CatalogEntry[];
}

// Parsed transparent catalogs, by key fingerprint. Valid while the catalog's own version header is
// unchanged, which is what lets a hot path skip re-parsing a multi-megabyte body.
const indexByKey = new Map<string, CachedIndex>();
const MAX_INDEXES = 200;

/** The transparent catalog for a key (or for no key), as the router sees it. */
async function loadTransparentCatalog(apiKey: string | null): Promise<CatalogEntry[]> {
  const request = markTransparentCatalogRequest(
    new Request("http://localhost/v1/models", {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    })
  );
  const response = await getUnifiedModelsResponse(request);
  if (response.status !== 200) return [];

  const fingerprint = fingerprintCatalogAuthKey(apiKey ?? "");
  const version = response.headers.get(RED_ROUTER_CATALOG_VERSION_HEADER) ?? "";
  const cached = indexByKey.get(fingerprint);
  if (version && cached && cached.version === version) {
    await response.body?.cancel();
    return cached.models;
  }

  const body = (await response.json()) as { data?: CatalogEntry[] };
  const models = Array.isArray(body?.data) ? body.data : [];
  if (version) {
    if (indexByKey.size >= MAX_INDEXES) indexByKey.clear();
    indexByKey.set(fingerprint, { version, models });
  }
  return models;
}

export interface PriorityRoutedCombo {
  id: string;
  name: string;
  strategy: "priority";
  models: string[];
  /** Marks a synthetic combo so logs and tests can tell it from a stored one. */
  virtual: true;
  routedBy: "provider-priority";
}

/**
 * A priority combo for `requestedModel`, or null when the request should go the normal way: the policy
 * is transparent, or no listed provider offers that model (unknown or hidden ids, combos and other
 * modalities keep their usual resolution).
 */
export async function resolvePriorityRoutedCombo(input: {
  apiKey: string | null;
  tenantId?: string | null;
  requestedModel: string;
}): Promise<PriorityRoutedCombo | null> {
  const requested = input.requestedModel?.trim();
  if (!requested) return null;

  const policy = await resolveRoutingPolicy(input.tenantId ?? null);
  if (policy.transparent) return null;

  const models = await loadTransparentCatalog(input.apiKey);
  const { aliasToProviderId } = buildAliasMaps();
  const targets = orderedTargetsFor(
    models,
    requested,
    policy.providerPriority,
    (providerId) => aliasToProviderId[providerId] || providerId
  );
  if (targets.length === 0) return null;

  const key = bareKey(requested);
  return {
    id: `priority:${key}`,
    name: key,
    strategy: "priority",
    models: targets.map((target) => target.id),
    virtual: true,
    routedBy: "provider-priority",
  };
}

/** Test hook: forget every parsed catalog. */
export function resetPriorityRoutingForTests(): void {
  indexByKey.clear();
}
