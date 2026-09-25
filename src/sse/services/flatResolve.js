// Request-side flat model ids: `typesafe/jev-1.13` resolves to the offers the
// caller's key may use, cheapest first, as an implicit fallback combo.
//
// Which reading wins when a flat id is also an offer id (the vendor's own offer,
// e.g. `openai/gpt-5` is both):
//   - a key whose catalog is flat gets the flat entry (RedRouter picks the offer);
//     it pins an offer with the offer's `pin_id` from /v1/models;
//   - a key whose catalog is prefixed gets the offer, as before flat ids existed,
//     and still reaches any flat id that is not also an offer id.
import { getApiKeyModelIdFormat } from "@/lib/db/repos/apiKeysRepo.js";
import { flatKey } from "@/lib/flatModels.js";

const TTL_MS = 60 * 1000;
const cache = new Map(); // apiKey|"" -> { at, flat: Map<id, members>, offerIds: Set<id> }

async function registryFor(apiKey) {
  const key = apiKey || "";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const { buildModelsList } = await import("@/app/api/v1/models/route.js");
  const entries = await buildModelsList(["llm"], { apiKey, idFormat: "flat" });
  const flat = new Map();
  const byKey = new Map(); // equivalent spellings ("4.5" / "4-5") -> the listed id
  const offerIds = new Set();
  for (const entry of entries) {
    if (!entry?.flat || !Array.isArray(entry.members) || !entry.members.length) continue;
    flat.set(entry.id, entry.members);
    byKey.set(flatKey(entry.id), entry.id);
    for (const offer of entry.offers || []) offerIds.add(offer.id);
  }
  const registry = { at: Date.now(), flat, byKey, offerIds };
  cache.set(key, registry);
  return registry;
}

/**
 * The members a flat id stands for, or null when the name is not a flat id for
 * this key (or reads as an offer for a prefixed key). A trailing thinking
 * override ("typesafe/jev-1.13(high)") is carried onto every member.
 * @returns {Promise<{ models: string[], comboName: string, suffix: string, flat: true }|null>}
 */
export async function resolveFlatModel(modelStr, { apiKey = null } = {}) {
  if (typeof modelStr !== "string" || !modelStr.includes("/")) return null;
  const match = modelStr.match(/^(.*)\(([^()]+)\)\s*$/);
  const name = match ? match[1].trim() : modelStr;
  const suffix = match ? `(${match[2]})` : "";
  const registry = await registryFor(apiKey);
  const listed = registry.flat.has(name) ? name : registry.byKey.get(flatKey(name));
  if (!listed) return null;
  if (registry.offerIds.has(name) && (await getApiKeyModelIdFormat(apiKey)) !== "flat") return null;
  const members = registry.flat.get(listed);
  const models = suffix ? members.map((m) => (/\([^()]+\)\s*$/.test(m) ? m : `${m}${suffix}`)) : members;
  return { models, comboName: listed, suffix, flat: true };
}

/** Test hook. */
export function resetFlatModelCache() {
  cache.clear();
}
