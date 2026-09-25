// Flat model ids: one catalog entry per model, whoever serves it.
//
// A prefixed catalog lists every offer (`openrouter/anthropic/claude-sonnet-4.5`,
// `red-router/opencode-go/typesafe/jev-1.13`, ...). A flat catalog groups those
// offers under `vendor/model` and lists each group as an implicit fallback combo
// whose members are the offers' full ids, cheapest first.
//
// Grouping never crosses two lines (user decision, 2026-09-25):
//   - versions: jev-1.13 and a later jev-1.14 stay apart, and "-latest" never
//     stands in for a released version;
//   - cost: a free offer (":free" / "-free", or priced 0) and a paid one are
//     separate entries, suffixed ":free", so a pick never moves between them.
// The models.dev canonical id (./modelCatalog/canonical.js) only supplies the
// vendor and is reported as `canonical`; it does not decide the group.
import { canonicalFor } from "@/lib/modelCatalog/canonical.js";

const FREE_SUFFIX = /(:free|-free)$/i;

/** The model part that tells versions apart: last segment, lower case, "." as "-", no free marker. */
export function versionKey(modelId) {
  return String(modelId).split("/").pop().replace(FREE_SUFFIX, "").toLowerCase().replace(/\./g, "-");
}

const isProviderEntry = (entry) => entry?.provider && entry.owned_by !== "combo" && entry.owned_by !== "alias";

/**
 * What a prefixed catalog entry actually serves: the innermost provider and its
 * own model id, plus the RedRouter hops in front of it (outermost first).
 */
export function offerOf(entry) {
  if (!isProviderEntry(entry)) return null;
  let rest = entry.id.startsWith(`${entry.owned_by}/`) ? entry.id.slice(entry.owned_by.length + 1) : entry.id;
  const route = Array.isArray(entry.route) ? entry.route : [];
  // Further RedRouter hops, then the served provider's own prefix, lead the remote id.
  for (const hop of route.slice(1)) {
    if (hop?.prefix && rest.startsWith(`${hop.prefix}/`)) rest = rest.slice(hop.prefix.length + 1);
  }
  const provider = entry.provider;
  if (route.length) {
    for (const p of [provider.prefix, provider.slug, provider.id]) {
      if (p && rest.startsWith(`${p}/`)) { rest = rest.slice(p.length + 1); break; }
    }
  }
  return {
    id: entry.id,
    providerId: provider.id,
    modelId: rest,
    name: entry.name || rest,
    provider: {
      id: provider.id,
      slug: provider.slug || provider.prefix || provider.id,
      name: provider.name || provider.id,
      category: provider.category || null,
      subscription: provider.subscription === true,
    },
    via: route.map((hop) => ({ slug: hop.prefix, name: hop.name || hop.prefix })),
    aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
  };
}

const priceTotal = (p) => (p ? (Number(p.input) || 0) + (Number(p.output) || 0) : Infinity);

/**
 * Group a prefixed catalog's provider entries into flat entries.
 * @param {object[]} entries  prefixed catalog entries (combos and aliases are ignored)
 * @param {{ priceOf: (providerId: string, modelId: string) => Promise<{input:number,output:number}|null> }} deps
 * @returns {Promise<object[]>} flat entries: `{ id, name, canonical, members, offers }`, members cheapest first
 */
export async function groupFlatOffers(entries, { priceOf }) {
  const groups = new Map();
  for (const entry of entries) {
    const offer = offerOf(entry);
    if (!offer || !offer.modelId) continue;
    const canonical = canonicalFor(offer.providerId, offer.modelId);
    const vendor = canonical
      ? canonical.id.split("/")[0]
      : offer.modelId.includes("/") ? offer.modelId.split("/")[0] : offer.provider.slug;
    const price = (await priceOf(offer.providerId, offer.modelId)) || null;
    const free = FREE_SUFFIX.test(offer.modelId) || (price !== null && priceTotal(price) === 0);
    const key = `${vendor}/${versionKey(offer.modelId)}${free ? ":free" : ""}`;
    if (!groups.has(key)) groups.set(key, { vendor, free, version: versionKey(offer.modelId), canonical: canonical?.id || null, offers: [], spellings: new Map() });
    const group = groups.get(key);
    const spelling = offer.modelId.split("/").pop().replace(FREE_SUFFIX, "");
    group.spellings.set(spelling, (group.spellings.get(spelling) || 0) + 1);
    group.offers.push({ ...offer, price, free, order: group.offers.length });
  }

  const flat = [];
  for (const group of groups.values()) {
    // A flat id must not change when a provider is connected or dropped: the
    // canonical model's spelling when it is this same version, else the one most
    // offers use (alphabetical on a tie).
    const canonicalSpelling = group.canonical ? group.canonical.split("/").pop() : null;
    const sameVersion = canonicalSpelling && versionKey(canonicalSpelling) === group.version;
    const spelling = sameVersion
      ? canonicalSpelling
      : [...group.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    const id = `${group.vendor}/${spelling}${group.free ? ":free" : ""}`;
    // Cheapest first, then the fewest router hops, then the vendor's own offer over
    // a reseller's, then catalog order.
    const own = (o) => (o.providerId === group.vendor ? 0 : 1);
    const offers = group.offers.sort((a, b) => priceTotal(a.price) - priceTotal(b.price)
      || a.via.length - b.via.length || own(a) - own(b) || a.order - b.order);
    flat.push({ id, key: flatKey(id), name: offers[0].name, canonical: group.canonical, free: group.free, offers });
  }
  return flat.sort((a, b) => a.id.localeCompare(b.id));
}

/** What makes two spellings of a flat id the same entry ("anthropic/claude-sonnet-4.5" ≈ "…-4-5"). */
export function flatKey(flatId) {
  const free = /:free$/i.test(flatId);
  const bare = String(flatId).replace(/:free$/i, "");
  const vendor = bare.includes("/") ? bare.split("/")[0].toLowerCase() : "";
  return `${vendor}/${versionKey(bare)}${free ? ":free" : ""}`;
}

/**
 * The id a client sends to pin one offer. An offer id equal to a flat id (the
 * vendor's own offer: `openai/gpt-5`) would resolve to the flat entry, so it pins
 * through one of its alias prefixes instead, or cannot be pinned (null).
 */
export function pinIdFor(offer, flatIds) {
  if (!flatIds.has(offer.id)) return offer.id;
  return offer.aliases.find((alias) => !flatIds.has(alias)) || null;
}

/**
 * An admin's order and switched-off offers for one flat entry (Models page),
 * saved per flat key. Offers the policy names come first, in its order; the rest
 * keep the default order after them (a new provider does not jump the queue).
 * Switched-off offers stay listed with `available: false` and are never members.
 * @param {object[]} offers  a group's offers, default order
 * @param {{ order?: string[], disabled?: string[] }|null|undefined} policy
 * @returns {{ offers: object[], custom: boolean }}
 */
export function applyFlatPolicy(offers, policy) {
  const order = Array.isArray(policy?.order) ? policy.order : [];
  const disabled = new Set(Array.isArray(policy?.disabled) ? policy.disabled : []);
  const rank = new Map(order.map((id, i) => [id, i]));
  const ranked = offers
    .map((offer, i) => ({ offer, i }))
    .sort((a, b) => (rank.get(a.offer.id) ?? order.length + a.i) - (rank.get(b.offer.id) ?? order.length + b.i))
    .map(({ offer }) => ({ ...offer, available: !disabled.has(offer.id) }));
  const custom = ranked.some((o, i) => o.id !== offers[i].id) || ranked.some((o) => !o.available);
  return { offers: ranked, custom };
}
