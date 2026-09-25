import { v4 as uuidv4 } from "uuid";
import { normalizeKeyRole } from "@/lib/apiKeyRole.js";
import { getDb } from "../kysely.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { normalizeOwnerInput, resolveDefaultOwner } from "@/lib/auth/resourceScope";
import { normalizeModelAccess, normalizeKeyLimits } from "@/lib/apiKeyPolicy.js";

// An empty binding list means "no restriction": the key reaches every account.
// Callers rely on null (not []) to express that, so normalize both ways here.
function normalizeAllowed(value) {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id) => typeof id === "string" && id.trim() !== "");
  return ids.length ? Array.from(new Set(ids)) : null;
}

const MAX_TAG_LENGTH = 32;
const MAX_TAGS = 20;

// Tags are display labels: trimmed, de-duplicated case-insensitively (the
// first spelling wins) and capped so one key cannot bloat the row.
export function normalizeTags(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const tags = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().slice(0, MAX_TAG_LENGTH);
    if (!tag) continue;
    const dedupeKey = tag.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags.length ? tags : null;
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    allowedConnectionIds: normalizeAllowed(parseJson(row.allowedConnectionIds, null)),
    tags: normalizeTags(parseJson(row.tags, null)) || [],
    modelAccess: normalizeModelAccess(parseJson(row.modelAccess, null)),
    limits: normalizeKeyLimits(parseJson(row.limits, null)),
    modelIdFormat: normalizeModelIdFormat(row.modelIdFormat),
    role: normalizeKeyRole(row.role),
    owner: row.owner ?? null,
    createdAt: row.createdAt,
  };
}

export async function getApiKeys() {
  const db = await getDb();
  const rows = await db.selectFrom("apiKeys").selectAll().orderBy("createdAt", "asc").execute();
  return rows.map(rowToKey);
}

export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getDb();
  const row = await db.selectFrom("apiKeys").selectAll().where("key", "=", key).executeTakeFirst();
  return rowToKey(row);
}

const MAX_SEARCH_LIMIT = 100;
const MAX_ID_LOOKUP = 1000;

/**
 * Find keys without loading them all (pickers over tens of thousands of keys):
 * by name or tag substring, or by id. Never returns the secret.
 * @param {{ q?: string, ids?: string[], limit?: number, offset?: number, owner?: string|null|undefined }} opts
 *   owner: undefined = every key; otherwise shared keys plus that owner's.
 * @returns {Promise<{ keys: {id,name,tags,isActive,owner,createdAt}[], total: number }>}
 */
export async function searchApiKeys({ q = "", ids = null, limit = 20, offset = 0, owner } = {}) {
  const db = await getDb();
  let size = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Number(limit) || 20));
  let query = db.selectFrom("apiKeys");
  if (Array.isArray(ids)) {
    if (!ids.length) return { keys: [], total: 0 };
    // A lookup by id returns every id asked for (names for chips), up to a sane cap.
    const wanted = [...new Set(ids)].slice(0, MAX_ID_LOOKUP);
    query = query.where("id", "in", wanted);
    size = wanted.length;
  }
  const term = String(q || "").trim().toLowerCase();
  if (term) {
    // % and _ typed in a search act as wildcards; harmless for a picker.
    const like = `%${term}%`;
    query = query.where((eb) => eb.or([
      eb(eb.fn("lower", ["name"]), "like", eb.val(like)),
      eb(eb.fn("lower", ["tags"]), "like", eb.val(like)),
    ]));
  }
  if (owner !== undefined) query = query.where((eb) => eb.or([eb("owner", "is", null), eb("owner", "=", owner)]));
  const [{ count }, rows] = await Promise.all([
    query.select((eb) => eb.fn.countAll().as("count")).executeTakeFirst(),
    query.select(["id", "name", "tags", "isActive", "owner", "createdAt"]).orderBy("name", "asc").limit(size).offset(Math.max(0, Number(offset) || 0)).execute(),
  ]);
  return {
    total: Number(count) || 0,
    keys: rows.map((r) => ({
      id: r.id, name: r.name, tags: normalizeTags(parseJson(r.tags, null)) || [],
      isActive: r.isActive === 1 || r.isActive === true, owner: r.owner ?? null, createdAt: r.createdAt,
    })),
  };
}

export async function getApiKeyById(id) {
  const db = await getDb();
  const row = await db.selectFrom("apiKeys").selectAll().where("id", "=", id).executeTakeFirst();
  return rowToKey(row);
}

export async function createApiKey(name, machineId, tags = null, owner = undefined) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getDb();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    allowedConnectionIds: null,
    tags: normalizeTags(tags) || [],
    modelAccess: null,
    limits: null,
    owner: owner === undefined ? await resolveDefaultOwner() : normalizeOwnerInput(owner),
    createdAt: new Date().toISOString(),
  };
  await db.insertInto("apiKeys").values({
    id: apiKey.id, key: apiKey.key, name: apiKey.name, machineId: apiKey.machineId,
    isActive: 1, allowedConnectionIds: null,
    tags: apiKey.tags.length ? stringifyJson(apiKey.tags) : null,
    owner: apiKey.owner, createdAt: apiKey.createdAt,
  }).execute();
  return apiKey;
}

// Bindings must not outlive the visibility that justified them: a key handed to
// another owner keeps routing to accounts that owner cannot see, because the
// binding list is consulted before ownership at request time. Dropping every
// binding would silently widen the key to all accounts ("no bindings = every
// account"), so only the now-unreachable ones go.
async function reachableConnectionIds(db, ids, owner) {
  if (!ids?.length) return null;
  const rows = await db.selectFrom("providerConnections").select(["id", "owner"])
    .where("id", "in", ids).execute();
  const ownerById = new Map(rows.map((r) => [r.id, r.owner ?? null]));
  const kept = ids.filter((connId) => {
    if (!ownerById.has(connId)) return false;
    const connOwner = ownerById.get(connId);
    return connOwner === null || connOwner === owner;
  });
  return kept.length ? kept : null;
}

export async function updateApiKey(id, data) {
  const db = await getDb();
  let result = null;
  await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("apiKeys").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return;
    const previous = rowToKey(row);
    const merged = { ...previous, ...data };
    merged.allowedConnectionIds = normalizeAllowed(merged.allowedConnectionIds);
    if (data.owner !== undefined && (merged.owner ?? null) !== (previous.owner ?? null)) {
      merged.allowedConnectionIds = await reachableConnectionIds(trx, merged.allowedConnectionIds, merged.owner ?? null);
    }
    const tags = normalizeTags(merged.tags);
    merged.tags = tags || [];
    merged.modelAccess = normalizeModelAccess(merged.modelAccess);
    merged.limits = normalizeKeyLimits(merged.limits);
    merged.modelIdFormat = normalizeModelIdFormat(merged.modelIdFormat);
    await trx.updateTable("apiKeys").set({
      key: merged.key, name: merged.name, machineId: merged.machineId,
      isActive: merged.isActive ? 1 : 0,
      allowedConnectionIds: merged.allowedConnectionIds ? stringifyJson(merged.allowedConnectionIds) : null,
      tags: tags ? stringifyJson(tags) : null,
      modelAccess: merged.modelAccess ? stringifyJson(merged.modelAccess) : null,
      limits: merged.limits ? stringifyJson(merged.limits) : null,
      modelIdFormat: merged.modelIdFormat === "prefixed" ? null : merged.modelIdFormat,
      role: normalizeKeyRole(merged.role) === "admin" ? "admin" : null,
      owner: merged.owner ?? null,
    }).where("id", "=", id).execute();
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getDb();
  const res = await db.deleteFrom("apiKeys").where("id", "=", id).executeTakeFirst();
  return Number(res?.numDeletedRows ?? 0) > 0;
}

/**
 * Connection ids this key is bound to, or null when it is unrestricted.
 * An unknown key is also unrestricted — key *validity* is a separate check
 * (validateApiKey), gated by settings.requireApiKey.
 */
export async function getApiKeyAllowedConnectionIds(key) {
  if (!key) return null;
  const db = await getDb();
  const row = await db.selectFrom("apiKeys").select("allowedConnectionIds").where("key", "=", key).executeTakeFirst();
  if (!row) return null;
  return normalizeAllowed(parseJson(row.allowedConnectionIds, null));
}

/**
 * The owner of a key, as stored. Used by the router, where there is no session:
 * the key itself carries the identity that caps which accounts it may reach.
 * An unknown key has no owner, matching validateApiKey being a separate check.
 */
/**
 * Identity of a key by its value: owner for scoping, name for labelling.
 * One lookup, since the router needs both on every request.
 */
export async function getApiKeyIdentity(key) {
  if (!key) return { id: null, owner: null, name: null };
  const db = await getDb();
  const row = await db.selectFrom("apiKeys").select(["id", "owner", "name"]).where("key", "=", key).executeTakeFirst();
  return { id: row?.id ?? null, owner: row?.owner ?? null, name: row?.name ?? null };
}

/** "flat" or "prefixed" (the default, stored as NULL). */
export function normalizeModelIdFormat(value) {
  return value === "flat" ? "flat" : "prefixed";
}

/** How /v1/models names models for this key ("prefixed" for unknown keys and no key). */
export async function getApiKeyModelIdFormat(key) {
  if (!key) return "prefixed";
  const db = await getDb();
  const row = await db.selectFrom("apiKeys").select("modelIdFormat").where("key", "=", key).executeTakeFirst();
  return normalizeModelIdFormat(row?.modelIdFormat);
}

const NO_POLICY = Object.freeze({ id: null, modelAccess: null, limits: null });

/**
 * What the router enforces for a key: its model rules and usage limits. An
 * unknown key has none, matching validateApiKey being a separate check.
 */
export async function getApiKeyPolicy(key) {
  if (!key) return NO_POLICY;
  const db = await getDb();
  const row = await db.selectFrom("apiKeys").select(["id", "modelAccess", "limits"]).where("key", "=", key).executeTakeFirst();
  if (!row) return NO_POLICY;
  return {
    id: row.id,
    modelAccess: normalizeModelAccess(parseJson(row.modelAccess, null)),
    limits: normalizeKeyLimits(parseJson(row.limits, null)),
  };
}

export async function getApiKeyOwner(key) {
  if (!key) return null;
  const db = await getDb();
  const row = await db.selectFrom("apiKeys").select("owner").where("key", "=", key).executeTakeFirst();
  return row?.owner ?? null;
}

export async function validateApiKey(key) {
  const db = await getDb();
  const row = await db.selectFrom("apiKeys").select("isActive").where("key", "=", key).executeTakeFirst();
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
