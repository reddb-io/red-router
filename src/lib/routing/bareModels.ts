/**
 * Bare model names and provider priority: the pure half of "non-transparent" model visibility.
 *
 * In transparent mode the catalog lists `provider/model` and the client chooses the provider. When it
 * is off, the catalog lists each model ONCE under its bare name, and a request for that name is routed
 * to the provider that ranks first in the priority order (falling through to the next on failure).
 *
 * Two models are "the same" when their ids match once lower-cased and stripped of every namespace, i.e.
 * everything up to the last "/" (`openai/gpt-4o`, `gpt-4o` and `openrouter/openai/gpt-4o` are one).
 * That is also why a request that still carries a provider prefix is accepted and the prefix ignored.
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

/** Everything after the last "/". */
export function stripNamespace(id: string): string {
  const trimmed = id.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/** The identity two providers' versions of a model share. */
export function bareKey(id: string): string {
  return stripNamespace(id).toLowerCase();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A chat model served by a provider (not a combo, not another modality). */
export function isChatProviderModel(entry: CatalogEntry): boolean {
  const id = text(entry.id);
  if (!id || !id.includes("/")) return false;
  if (entry.owned_by === "combo" || entry.owned_by === ROUTER_OWNER) return false;
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

function displayId(entry: CatalogEntry): string {
  const source = text(entry.root) || text(entry.id);
  return stripNamespace(source);
}

const PROVIDER_ONLY_FIELDS = ["provider", "provider_id", "providerId", "parent"] as const;

/**
 * The catalog with each chat model listed once under its bare name, taken from the provider that
 * ranks first. Combos and every other modality are left exactly as they were.
 */
export function collapseCatalogToBare<T extends CatalogEntry>(
  models: readonly T[],
  priority: readonly string[],
  canonical?: (providerId: string) => string
): T[] {
  const rank = makeRanker(priority, canonical);
  const best = new Map<string, { entry: T; rank: number }>();
  for (const entry of models) {
    if (!isChatProviderModel(entry)) continue;
    const key = bareKey(text(entry.root) || text(entry.id));
    const entryRank = rank(entry);
    const current = best.get(key);
    if (!current || entryRank < current.rank) best.set(key, { entry, rank: entryRank });
  }

  const emitted = new Set<string>();
  const out: T[] = [];
  for (const entry of models) {
    if (!isChatProviderModel(entry)) {
      out.push(entry);
      continue;
    }
    const key = bareKey(text(entry.root) || text(entry.id));
    if (emitted.has(key)) continue;
    emitted.add(key);
    const chosen = best.get(key)!.entry;
    const bare = displayId(chosen);
    const rewritten: Record<string, unknown> = {
      ...chosen,
      id: bare,
      root: bare,
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
  canonical?: (providerId: string) => string
): Target[] {
  const key = bareKey(requested);
  if (!key) return [];
  const rank = makeRanker(priority, canonical);
  const matches = models
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        isChatProviderModel(entry) && bareKey(text(entry.root) || text(entry.id)) === key
    )
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
