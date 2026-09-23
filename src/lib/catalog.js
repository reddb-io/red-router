// GET /v1/catalog: the /v1/models catalog grouped by provider, the combos, and the
// models RedRouter recommends for the accounts the caller has connected.
import { buildModelsList, catalogConnections } from "@/app/api/v1/models/route.js";
import { getCatalogVersion } from "@/lib/catalogVersion";
import { buildRecommendations } from "@/lib/modelRecommendations.js";
import { connectionModelPrefix, providerIdentity } from "open-sse/providers/identity.js";

const COMBO_PROVIDER_ID = "combo";
// User aliases are listed beside the models they point at, not as models of a provider.
const ALIAS_OWNER = "alias";
const REMOTE_ROUTER_ID = "red-router";

/**
 * The catalog document for one caller.
 * @param {object} [options] - { apiKey, scopeFilter, variants } as for buildModelsList
 * @returns {Promise<{ version: string|null, groups: object[], combos: object[], recommended: object }>}
 */
export async function buildCatalog(options = {}) {
  const sources = await loadCatalogSources(options);
  return {
    version: await getCatalogVersion(options.apiKey || null),
    groups: groupCatalog(sources.models, sources.connections),
    combos: sources.models.filter((entry) => entry.provider?.id === COMBO_PROVIDER_ID),
    aliases: sources.models.filter((entry) => entry.owned_by === ALIAS_OWNER),
    recommended: buildRecommendations(sources.connected, sources.systemOne).recommended,
  };
}

/** The combos a recommended setup would create for one caller (see buildRecommendations). */
export async function recommendedComboSpecs(options = {}) {
  const sources = await loadCatalogSources(options);
  return buildRecommendations(sources.connected, sources.systemOne);
}

async function loadCatalogSources(options) {
  const scope = { apiKey: options.apiKey || null, scopeFilter: options.scopeFilter, variants: options.variants };
  const [models, systemOne, access] = await Promise.all([
    buildModelsList(["llm"], scope),
    // System One is optional: an unreachable catalog only drops that recommendation.
    buildModelsList(["systemone"], scope).catch(() => []),
    catalogConnections(scope),
  ]);
  // With no account at all /v1/models falls back to the static catalog; nothing in
  // it is connected, so nothing is recommended.
  const connected = access.connections.length ? models.filter((entry) => entry.owned_by !== ALIAS_OWNER) : [];
  return { models, connected, systemOne: access.connections.length ? systemOne : [], connections: access.connections };
}

/**
 * Provider entries grouped by the provider that serves them, in catalog order. Each
 * group's provider block adds `connections`: the caller's active accounts for it. A
 * model reached through a remote RedRouter belongs to the local red-router group. A
 * provider listed under connection model prefixes has one group per prefix, whose
 * block adds `model_prefix` and, when one account carries it, `connection`.
 */
export function groupCatalog(models, connections) {
  const groups = new Map();
  for (const entry of models) {
    if (!entry?.id || entry.provider?.id === COMBO_PROVIDER_ID || entry.owned_by === ALIAS_OWNER) continue;
    const providerKey = entry.via === REMOTE_ROUTER_ID ? REMOTE_ROUTER_ID : entry.provider?.id || entry.owned_by;
    const prefixed = connections.some((conn) => conn.provider === providerKey && connectionModelPrefix(conn) === entry.owned_by);
    const key = prefixed ? `${providerKey}/${entry.owned_by}` : providerKey;
    if (!groups.has(key)) groups.set(key, { provider: groupProvider(providerKey, entry, connections, prefixed), models: [] });
    groups.get(key).models.push(entry);
  }
  return [...groups.values()];
}

function groupProvider(key, entry, connections, prefixed) {
  const identity = key === REMOTE_ROUTER_ID ? providerIdentity(REMOTE_ROUTER_ID) : entry.provider;
  const source = identity || { id: key, slug: entry.owned_by, prefix: entry.owned_by, name: entry.owned_by, category: "custom", subscription: false };
  const own = connections.filter((conn) => conn.provider === key);
  const block = {
    id: source.id,
    slug: source.slug,
    prefix: source.prefix,
    name: source.name,
    category: source.category,
    subscription: source.subscription === true,
    connections: prefixed ? own.filter((conn) => connectionModelPrefix(conn) === entry.owned_by).length : own.length,
  };
  if (prefixed) block.model_prefix = entry.owned_by;
  if (prefixed && entry.provider?.connection) block.connection = entry.provider.connection;
  return block;
}
