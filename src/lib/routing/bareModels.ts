/**
 * Bare model names and provider priority: the pure half of "non-transparent" model visibility.
 *
 * In transparent mode the catalog lists `provider/model` and the client chooses the provider. When it
 * is off, the catalog lists each model ONCE under its bare name, and a request for that name is routed
 * to the provider that ranks first in the priority order (falling through to the next on failure).
 *
 * Manufacturer namespaces remain part of model identity. Legacy short names remain valid only when
 * they identify one family in the authorized catalog. Routing hops are transport, not identity.
 */

export const ROUTER_OWNER = "red-router";

export interface CatalogEntry {
  id?: unknown;
  root?: unknown;
  owned_by?: unknown;
  type?: unknown;
  [key: string]: unknown;
}

export interface Target {
  /** The full transparent id to dispatch to (`provider/model`). */
  id: string;
  provider: string;
}

const ROUTER_PREFIXES = new Set(["red", "red-router", "redrouter"]);
const GATEWAY_PREFIXES = new Set(["openrouter"]);

/** Remove router/gateway transport hops, preserving manufacturer namespaces. */
export function stripNamespace(id: string): string {
  const parts = id.trim().split("/");
  while (parts.length > 1 && ROUTER_PREFIXES.has(parts[0].toLowerCase())) parts.shift();
  if (parts.length > 1 && GATEWAY_PREFIXES.has(parts[0].toLowerCase())) parts.shift();
  return parts.join("/");
}

export function bareKey(id: string): string {
  return stripNamespace(id).toLowerCase();
}

const leaf = (id: string) => id.slice(id.lastIndexOf("/") + 1);

/** Root is already a provider's model ID. Only federated roots still contain transport providers. */
export function modelIdentity(entry: CatalogEntry): string {
  if (text(entry.model_identity)) return text(entry.model_identity).trim();
  const root = text(entry.root);
  let source = root || text(entry.id).split("/").slice(1).join("/");
  const owner = text(entry.owned_by).toLowerCase();
  if (ROUTER_PREFIXES.has(owner)) {
    const parts = source.split("/");
    while (parts.length > 1 && ROUTER_PREFIXES.has(parts[0].toLowerCase())) parts.shift();
    if (parts.length > 1 && GATEWAY_PREFIXES.has(parts[0].toLowerCase())) parts.shift();
    source = parts.join("/");
  }
  return source.trim();
}

/** Resolve direct unqualified models against a manufacturer ID only when the owner agrees. */
function identityIndex(
  models: readonly CatalogEntry[],
  canonical: (id: string) => string = (id) => id
) {
  const qualified = new Map<string, Set<string>>();
  for (const entry of models) {
    if (!isPriorityModel(entry)) continue;
    const id = modelIdentity(entry).toLowerCase();
    if (!id.includes("/")) continue;
    const key = `${entry.type === "systemone" ? "decision" : "chat"}:${leaf(id)}`;
    const set = qualified.get(key) ?? new Set<string>();
    set.add(id);
    qualified.set(key, set);
  }
  const identities = new Map<CatalogEntry, string>();
  const families = new Map<string, Set<string>>();
  for (const entry of models) {
    if (!isPriorityModel(entry)) continue;
    let id = modelIdentity(entry).toLowerCase();
    const kind = entry.type === "systemone" ? "decision" : "chat";
    if (!id.includes("/")) {
      const matching = [...(qualified.get(`${kind}:${id}`) ?? [])].filter((candidate) =>
        providerKeys(entry).some(
          (provider) =>
            canonical(provider).toLowerCase() === canonical(candidate.split("/")[0]).toLowerCase()
        )
      );
      if (matching.length === 1) id = matching[0];
    }
    identities.set(entry, id);
    const key = `${kind}:${leaf(id)}`;
    const set = families.get(key) ?? new Set<string>();
    set.add(id);
    families.set(key, set);
  }
  return { identities, families };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A chat model served by a provider (not a combo, not another modality). */
export function isChatProviderModel(entry: CatalogEntry): boolean {
  const id = text(entry.id);
  if (!id || !id.includes("/")) return false;
  if (entry.owned_by === "combo") return false;
  return entry.type === undefined || entry.type === "chat";
}

/** The provider ids an entry can be ranked under: its owner and its id prefix. */
export function providerKeys(entry: CatalogEntry): string[] {
  const keys: string[] = [];
  const owner = text(entry.owned_by);
  if (owner) keys.push(owner);
  const id = text(entry.id);
  const slash = id.indexOf("/");
  if (slash > 0) keys.push(id.slice(0, slash));
  return keys;
}

/**
 * A rank function for entries: the index of the first listed provider that matches one of the
 * entry's provider keys; unlisted providers all share the rank after the last listed one.
 */
export function makeRanker(
  priority: readonly string[],
  canonical: (providerId: string) => string = (id) => id
): (entry: CatalogEntry) => number {
  const order = new Map<string, number>();
  priority.forEach((id, index) => {
    const key = canonical(id).toLowerCase();
    if (!order.has(key)) order.set(key, index);
  });
  return (entry) => {
    for (const key of providerKeys(entry)) {
      const rank = order.get(canonical(key).toLowerCase());
      if (rank !== undefined) return rank;
    }
    return priority.length;
  };
}

function displayId(
  entry: CatalogEntry,
  identity: string,
  families: Map<string, Set<string>>
): string {
  const kind = entry.type === "systemone" ? "decision" : "chat";
  const original = modelIdentity(entry);
  return families.get(`${kind}:${leaf(identity)}`)?.size === 1 ? leaf(original) : identity;
}

const PROVIDER_ONLY_FIELDS = ["provider", "provider_id", "providerId", "parent", "route"] as const;

export function isDecisionProviderModel(entry: CatalogEntry): boolean {
  return (
    typeof entry.id === "string" &&
    entry.id.includes("/") &&
    entry.owned_by !== "combo" &&
    entry.type === "systemone"
  );
}

function isPriorityModel(entry: CatalogEntry): boolean {
  return isChatProviderModel(entry) || isDecisionProviderModel(entry);
}

/**
 * The catalog with each chat or decision model listed once under its bare name, taken from the provider that
 * ranks first. Chat and decisions remain separate; combos and other modalities keep their IDs.
 */
export function collapseCatalogToBare<T extends CatalogEntry>(
  models: readonly T[],
  priority: readonly string[],
  canonical?: (providerId: string) => string
): T[] {
  const rank = makeRanker(priority, canonical);
  const { identities, families } = identityIndex(models, canonical);
  const priorityKey = (entry: CatalogEntry) =>
    `${entry.type === "systemone" ? "decision" : "chat"}:${identities.get(entry)}`;
  const best = new Map<string, { entry: T; rank: number }>();
  for (const entry of models) {
    if (!isPriorityModel(entry)) continue;
    const key = priorityKey(entry);
    const entryRank = rank(entry);
    const current = best.get(key);
    if (!current || entryRank < current.rank) best.set(key, { entry, rank: entryRank });
  }

  const emitted = new Set<string>();
  const out: T[] = [];
  for (const entry of models) {
    if (!isPriorityModel(entry)) {
      out.push(entry);
      continue;
    }
    const key = priorityKey(entry);
    if (emitted.has(key)) continue;
    emitted.add(key);
    const chosen = best.get(key)!.entry;
    const bare = displayId(chosen, identities.get(chosen)!, families);
    const rewritten: Record<string, unknown> = {
      ...chosen,
      id: bare,
      root: bare,
      model_identity: identities.get(chosen),
      owned_by: ROUTER_OWNER,
    };
    for (const field of PROVIDER_ONLY_FIELDS) delete rewritten[field];
    out.push(rewritten as T);
  }
  return out;
}

/**
 * Where a request for `requested` may go, best provider first: every listed chat model whose bare key
 * matches, ordered by provider priority (ties keep catalog order), one target per full id.
 */
export function orderedTargetsFor(
  models: readonly CatalogEntry[],
  requested: string,
  priority: readonly string[],
  canonical?: (providerId: string) => string,
  kind: "chat" | "decision" = "chat"
): Target[] {
  const { identities, families } = identityIndex(models, canonical);
  const eligible = (entry: CatalogEntry) =>
    kind === "decision" ? isDecisionProviderModel(entry) : isChatProviderModel(entry);
  const input = requested.trim().toLowerCase();
  if (!input) return [];
  const exact = models.filter((entry) => eligible(entry) && text(entry.id).toLowerCase() === input);
  let key = exact.length ? identities.get(exact[0]) : undefined;
  if (!key) {
    const normalized = bareKey(requested);
    const roots = new Set(models.filter(eligible).map((entry) => identities.get(entry)));
    if (roots.has(normalized)) key = normalized;
    else {
      const legacy = families.get(`${kind}:${leaf(normalized)}`);
      // Only an unqualified legacy ID may use the short-name fallback. Unknown namespaces never
      // select another manufacturer's family, and ambiguous names do not pick a provider silently.
      if (!normalized.includes("/") && legacy?.size === 1) key = [...legacy][0];
    }
  }
  if (!key) return [];
  // An unqualified name shared by several families must stay ambiguous even when one root is bare.
  if (!input.includes("/") && (families.get(`${kind}:${input}`)?.size ?? 0) > 1) return [];
  const rank = makeRanker(priority, canonical);
  const matches = models
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => eligible(entry) && identities.get(entry) === key)
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index);

  const seen = new Set<string>();
  const targets: Target[] = [];
  for (const { entry } of matches) {
    const id = text(entry.id);
    if (seen.has(id)) continue;
    seen.add(id);
    targets.push({ id, provider: providerKeys(entry)[0] ?? id.slice(0, id.indexOf("/")) });
  }
  return targets;
}
