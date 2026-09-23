import { getDb } from "../kysely.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");
// The name /v1/models shows for a user alias: key=alias, value=name.
const aliasNameKv = makeKv("modelAliasNames");
// A user's display name for a provider model: key=`${providerId}/${modelId}`, value=name.
const modelNameKv = makeKv("modelNames");

// modelAliases: key=alias, value=modelString
export async function getModelAliases() {
  return await aliasKv.getAll();
}

export async function setModelAlias(alias, model) {
  await aliasKv.set(alias, model);
}

export async function deleteModelAlias(alias) {
  await aliasKv.remove(alias);
  await aliasNameKv.remove(alias);
}

export async function getModelAliasNames() {
  return await aliasNameKv.getAll();
}

/** An empty name removes it: the alias then shows under its own id. */
export async function setModelAliasName(alias, name) {
  const value = typeof name === "string" ? name.trim() : "";
  if (value) await aliasNameKv.set(alias, value);
  else await aliasNameKv.remove(alias);
}

export async function getModelDisplayNames() {
  return await modelNameKv.getAll();
}

/** An empty name removes the override: the model shows its catalog name again. */
export async function setModelDisplayName(modelKey, name) {
  const value = typeof name === "string" ? name.trim() : "";
  if (value) await modelNameKv.set(modelKey, value);
  else await modelNameKv.remove(modelKey);
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels() {
  const all = await customKv.getAll();
  return Object.values(all);
}

// Atomic upsert inside transaction to prevent duplicate races.
// Re-adding an existing model updates caps/name without resetting omitted fields.
export async function addCustomModel({ providerAlias, id, type = "llm", name, caps }) {
  const k = customKey(providerAlias, id, type);
  const db = await getDb();
  let added = false;
  await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("kv").select("value")
      .where("scope", "=", "customModels").where("key", "=", k).executeTakeFirst();
    if (row) {
      const prev = parseJson(row.value) || {};
      const next = { ...prev, ...(name ? { name } : {}), ...(caps ? { caps } : {}) };
      await trx.updateTable("kv").set({ value: stringifyJson(next) })
        .where("scope", "=", "customModels").where("key", "=", k).execute();
      return;
    }
    const value = stringifyJson({ providerAlias, id, type, name: name || id, ...(caps ? { caps } : {}) });
    await trx.insertInto("kv").values({ scope: "customModels", key: k, value }).execute();
    added = true;
  });
  return added;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  await customKv.remove(customKey(providerAlias, id, type));
}

// mitmAlias: key=toolName, value=mappings object
export async function getMitmAlias(toolName) {
  if (toolName) {
    const v = await mitmKv.get(toolName);
    return v || {};
  }
  return await mitmKv.getAll();
}

export async function setMitmAliasAll(toolName, mappings) {
  await mitmKv.set(toolName, mappings || {});
}
