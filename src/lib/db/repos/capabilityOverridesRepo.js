import { getDb } from "../kysely.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// User corrections to a model's capabilities, keyed "<providerId>/<model>" or
// "*/<model>" (any provider). Values are partial capability objects.
const SCOPE = "capabilityOverrides";

export async function getCapabilityOverrides() {
  const db = await getDb();
  const rows = await db.selectFrom("kv").select(["key", "value"]).where("scope", "=", SCOPE).execute();
  const out = {};
  for (const r of rows) out[r.key] = parseJson(r.value, {});
  return out;
}

/** Store the override for a key, or remove it when `caps` is null/empty. */
export async function setCapabilityOverride(key, caps) {
  const db = await getDb();
  if (!caps || Object.keys(caps).length === 0) {
    await db.deleteFrom("kv").where("scope", "=", SCOPE).where("key", "=", key).execute();
    return;
  }
  const value = stringifyJson(caps);
  await db.insertInto("kv").values({ scope: SCOPE, key, value })
    .onConflict((oc) => oc.columns(["scope", "key"]).doUpdateSet({ value }))
    .execute();
}
