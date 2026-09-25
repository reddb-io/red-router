import { INTERNAL_MODELS_FETCH_HEADER, catalogFetchOptions, syncRemoteRouterCatalog } from "@/lib/remoteRouterCatalog";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS, getModelKind, findModelName } from "@/shared/constants/models";
import {
  AI_PROVIDERS,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";
import { connectionModelPrefix, providerIdentity, providerLegacyPrefix, providerSlug } from "open-sse/providers/identity.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import { groupModelVariants, mergeVariantLevels, variantBaseName } from "open-sse/providers/modelVariants.js";
import { getProviderConnections, getCombos, getCustomModels, getModelAliases, getModelAliasNames, getModelDisplayNames, getApiKeyAllowedConnectionIds, getApiKeyOwner, getSettings } from "@/lib/localDb";
import { connectionLabel } from "@/lib/connectionPrefix";
import { catalogEntryFor } from "@/lib/catalogEntry";
import { parseModel } from "@/sse/services/model.js";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { getApiKeyPolicy } from "@/lib/localDb";
import { modelAccessAllows, modelAccessNames } from "@/lib/modelAccess";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { resolveKimchiModels } from "open-sse/services/kimchiModels.js";
import { resolveQoderModels, routableQoderModels } from "open-sse/services/qoderModels.js";
import { resolveCopilotModels } from "open-sse/services/copilotModels.js";
import { resolveClinepassModels, resolveClineModels } from "open-sse/services/clinepassModels.js";
import { resolveGrokCliModels } from "open-sse/services/grokCliModels.js";
import { resolveCursorModels } from "open-sse/services/cursorModels.js";
import { resolveZedModels } from "open-sse/shared/zedAuth.js";
import { updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { capabilitiesFromServiceKind, getCapabilitiesForModel, DEFAULT_CAPABILITIES } from "open-sse/providers/capabilities.js";
import { getThinkingLevelsForId } from "open-sse/providers/thinkingLevels.js";
import { modelParameters, mergeModelParameters } from "open-sse/providers/modelParameters.js";
import { comboThinkingLevels, comboStrategyFor } from "open-sse/services/combo.js";
import { stripThinkingSuffix } from "open-sse/translator/concerns/thinkingUnified.js";
import { extractApiKey } from "@/sse/services/auth.js";
import { getCatalogVersion } from "@/lib/catalogVersion";
import { CATALOG_VERSION_HEADER } from "open-sse/config/runtimeConfig.js";
import { SYSTEM_ONE_CREDENTIAL_SOURCES } from "open-sse/config/systemOne.js";
import { resolveOpenCodeGoModels, resolveOpenCodeZenSystemOneModels } from "open-sse/services/opencodeCatalog.js";
import { modelsDevModels } from "@/lib/modelCatalog/browse";
import { applyFlatPolicy, groupFlatOffers, pinIdFor } from "@/lib/flatModels.js";
import { getPricingForModel } from "@/lib/db/repos/pricingRepo.js";
import { getApiKeyModelIdFormat, getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import {
  RED_ROUTER_INSTANCE_HEADER,
  RED_ROUTER_INSTANCE_ID,
  appendRedRouterHop,
  parseRedRouterChain,
} from "open-sse/config/redRouter.js";

// Per-provider live model resolvers. Each receives a connection record and
// returns { models: [{ id, name? }, ...] } | null on failure.
// Adding a provider here makes /v1/models prefer the live catalog for it.
// A remote RedRouter's catalog depends on the hop chain; buildModelsList fetches it.
const LIVE_MODEL_RESOLVERS = {
  kiro: async (conn) => {
    const result = await resolveKiroModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  qoder: async (conn) => {
    const result = await resolveQoderModels({
      accessToken: conn.accessToken,
      // PAT (pt-...) connections keep the token in apiKey; without it the live
      // catalog silently fails and /v1/models falls back to the static list.
      apiKey: conn.apiKey,
      refreshToken: conn.refreshToken,
      email: conn.email,
      displayName: conn.displayName,
      providerSpecificData: conn.providerSpecificData || {}
    });
    // Visible + hidden (enable:false) catalog keys — chat routes all of them.
    const models = routableQoderModels(result);
    if (!models.length) return null;
    return { models: models.map((m) => ({ id: m.id, name: m.name })) };
  },
  kimchi: async (conn) => {
    const result = await resolveKimchiModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  github: async (conn) => {
    const result = await resolveCopilotModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, {
      log: console,
      onCredentialsRefreshed: async (refreshed) => {
        await updateProviderCredentials(conn.id, {
          copilotToken: refreshed.copilotToken,
          copilotTokenExpiresAt: refreshed.copilotTokenExpiresAt,
          existingProviderSpecificData: conn.providerSpecificData || {},
        });
      },
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  clinepass: async (conn) => {
    const result = await resolveClinepassModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  cline: async (conn) => {
    const result = await resolveClineModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  "grok-cli": async (conn) => {
    const proxy = await resolveConnectionProxyConfig(conn.providerSpecificData || {});
    const result = await resolveGrokCliModels({
      ...conn,
      connectionId: conn.id,
    }, {
      log: console,
      proxyOptions: {
        connectionProxyEnabled: proxy.connectionProxyEnabled === true,
        connectionProxyUrl: proxy.connectionProxyUrl || "",
        connectionNoProxy: proxy.connectionNoProxy || "",
        vercelRelayUrl: proxy.vercelRelayUrl || "",
        strictProxy: proxy.strictProxy === true,
      },
      onCredentialsRefreshed: async (refreshed) => {
        await updateProviderCredentials(conn.id, {
          ...refreshed,
          existingProviderSpecificData: conn.providerSpecificData || {},
        });
      },
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  cursor: async (conn) => {
    const result = await resolveCursorModels({
      accessToken: conn.accessToken,
      providerSpecificData: conn.providerSpecificData || {},
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  // OpenCode's public Go list says which Go models exist today; models the built-in
  // list lacks take models.dev's facts. Null (built-in list) when it is unreachable.
  "opencode-go": async () => {
    const facts = modelsDevModels("opencode-go");
    const result = await resolveOpenCodeGoModels({ modelsDev: facts });
    if (result.source !== "live") return null;
    const builtIn = new Set((PROVIDER_MODELS["opencode-go"] || []).map((m) => m.id));
    return {
      models: result.models.map((m) => (builtIn.has(m.id)
        ? { id: m.id, name: m.name }
        : { id: m.id, name: m.name, capabilities: discoveredCapabilities("opencode-go", m.id, facts[m.id]) })),
    };
  },
  zed: async (conn) => {
    const result = await resolveZedModels({
      accessToken: conn.accessToken,
      providerSpecificData: conn.providerSpecificData || {},
    });
    if (!result?.models?.length) return null;
    return {
      models: result.models
        .filter((m) => !m.isDisabled)
        .map((m) => ({
          id: m.id,
          name: m.name,
          capabilities: m.supportsTools ? { tools: true } : undefined,
        })),
    };
  },
};

/**
 * Capabilities of a model only a live catalog knows: the pattern table's guess,
 * corrected by what models.dev states (browseShape keys), when it has the model.
 */
function discoveredCapabilities(providerId, modelId, facts) {
  const caps = { ...getCapabilitiesForModel(providerId, modelId) };
  if (!facts) return caps;
  const inputs = Array.isArray(facts.i) ? facts.i : [];
  Object.assign(caps, {
    vision: inputs.includes("image"),
    pdf: inputs.includes("pdf"),
    audioInput: inputs.includes("audio"),
    videoInput: inputs.includes("video"),
    reasoning: facts.r === true,
    tools: facts.t === true,
  });
  if (facts.c > 0) caps.contextWindow = facts.c;
  if (facts.o > 0) caps.maxOutput = facts.o;
  return caps;
}

// Live System One lists of providers whose models can be reached with another
// provider's key (SYSTEM_ONE_CREDENTIAL_SOURCES). Without one, the built-in list.
const SYSTEM_ONE_LIVE_RESOLVERS = {
  "opencode-zen": resolveOpenCodeZenSystemOneModels,
};

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};


// LLM kind sentinel — combos/models with no explicit kind default to LLM
const LLM_KIND = "llm";
const SYSTEM_ONE_KIND = "systemone";

// settings.catalog.prefixStyle: "slug" lists "<slug>/<model>" (readable, the default);
// "short" keeps the legacy short codes ("cc/<model>") for clients that cannot migrate.
const PREFIX_STYLES = new Set(["slug", "short"]);
const COMBO_PROVIDER = { id: "combo", name: "Combo" };
const REMOTE_ROUTER_ID = "red-router";

// settings.catalog.variants (or ?variants=): "collapse" folds level/mode variant ids
// ("gpt-5.5-review", "gemini-3.8-flash-high") into their base entry, "expand" lists
// each one as its own entry the way older clients expect.
const VARIANT_MODES = new Set(["collapse", "expand"]);

function catalogVariantsMode(settings, requested) {
  if (VARIANT_MODES.has(requested)) return requested;
  const configured = settings?.catalog?.variants;
  return VARIANT_MODES.has(configured) ? configured : "collapse";
}

/**
 * Fold one provider's variant ids into their base. Returns the ids to list (a table
 * base that is not a model of its own takes its first variant's place) and the
 * variants of each listed base.
 */
function collapseVariants(providerId, ids, mode) {
  const groups = mode === "expand" ? new Map() : groupModelVariants(providerId, ids);
  if (groups.size === 0) return { ids, groups };
  const baseOf = new Map([...groups].flatMap(([base, variants]) => variants.map((v) => [v.id, base])));
  const listed = [];
  for (const id of ids) {
    const base = baseOf.get(id);
    const next = base === undefined ? id : ids.includes(base) ? null : base;
    if (next && !listed.includes(next)) listed.push(next);
  }
  return { ids: listed, groups };
}

/** The `variants` block of a base entry: each legacy variant id and what it selects. */
function variantEntries(prefixes, variants, nameOf) {
  return variants.map((variant) => ({
    id: `${prefixes.prefix}/${variant.id}`,
    name: nameOf(variant.id),
    ...(variant.level ? { level: variant.level } : {}),
    ...(variant.mode ? { mode: variant.mode } : {}),
    ...(prefixes.others.length ? { aliases: prefixes.others.map((p) => `${p}/${variant.id}`) } : {}),
  }));
}

function catalogPrefixStyle(settings) {
  const style = settings?.catalog?.prefixStyle;
  return PREFIX_STYLES.has(style) ? style : "slug";
}

/**
 * The prefix a provider's models are listed under, and the other prefixes that route
 * to the same provider — emitted as `aliases` so clients can migrate saved ids. A
 * user-chosen prefix (custom nodes) is listed as is.
 */
function listingPrefixes(providerId, prefixStyle, customPrefix = "") {
  if (customPrefix) return { prefix: customPrefix, others: [] };
  const slug = providerSlug(providerId);
  const legacy = providerLegacyPrefix(providerId);
  const prefix = prefixStyle === "short" ? legacy : slug;
  return { prefix, others: [...new Set([slug, legacy])].filter((p) => p !== prefix) };
}

/**
 * The prefixes one provider's models are listed under, each with the accounts it routes
 * to. A built-in provider lists its models once per distinct connection model prefix,
 * and once under its default prefix when some account has none. The slug and legacy
 * forms are offered as `aliases` of a connection prefix only when they reach the same
 * accounts, i.e. when every account carries that prefix. Custom nodes keep one listing
 * under the node prefix.
 * @returns {{ conn: object, prefixes: { prefix: string, others: string[] }, connections: object[] }[]}
 */
function providerListings(providerId, providerConnections, prefixStyle) {
  if (!providerIdentity(providerId)) {
    const conn = providerConnections[0];
    const customPrefix = typeof conn?.providerSpecificData?.prefix === "string" ? conn.providerSpecificData.prefix.trim() : "";
    return [{ conn, prefixes: listingPrefixes(providerId, prefixStyle, customPrefix), connections: [] }];
  }
  const byPrefix = new Map();
  const unprefixed = [];
  for (const conn of providerConnections) {
    const prefix = connectionModelPrefix(conn);
    if (!prefix) unprefixed.push(conn);
    else byPrefix.set(prefix, [...(byPrefix.get(prefix) || []), conn]);
  }
  const defaults = listingPrefixes(providerId, prefixStyle);
  const listings = [...byPrefix].map(([prefix, connections]) => ({
    conn: connections[0],
    prefixes: {
      prefix,
      others: connections.length === providerConnections.length ? [defaults.prefix, ...defaults.others] : [],
    },
    connections,
  }));
  if (unprefixed.length) listings.push({ conn: unprefixed[0], prefixes: defaults, connections: [] });
  return listings;
}

/** The `provider` block: registry identity, or the custom node the prefix belongs to. */
function listingProvider(providerId, prefix, conn) {
  return providerIdentity(providerId) || {
    id: providerId,
    slug: prefix,
    prefix,
    name: conn?.providerSpecificData?.nodeName || prefix,
    category: "custom",
    subscription: false,
  };
}

/** id, owned_by, name, provider and aliases shared by every provider-model entry. */
function providerModelEntry({ prefixes, modelId, name, provider, extra = {} }) {
  const entry = {
    id: `${prefixes.prefix}/${modelId}`,
    object: "model",
    ...extra,
    owned_by: prefixes.prefix,
    name: name || modelId,
  };
  if (provider) entry.provider = provider;
  if (prefixes.others.length) entry.aliases = prefixes.others.map((p) => `${p}/${modelId}`);
  return entry;
}

/**
 * One router hop of a `route`: the RedRouter connection prefix it takes, the remote
 * instance it reaches (when the remote says), and the account when one serves it.
 */
function routerHop(prefixes, instanceId, connections) {
  const hop = { id: REMOTE_ROUTER_ID, name: providerIdentity(REMOTE_ROUTER_ID)?.name || "RedRouter", prefix: prefixes.prefix };
  if (instanceId) hop.instance = instanceId;
  if (connections.length === 1) hop.connection = { id: connections[0].id, name: connectionLabel(connections[0]) };
  return hop;
}

/**
 * A model served by a remote RedRouter keeps the remote's own name and provider;
 * `via` says it is reached through this instance's red-router account, and `route`
 * lists every router hop, this one first, then the remote's own route when the remote
 * re-exposes a router further up ("red-router/red-router/opencode-go/<model>").
 */
function remoteRouterEntry(prefixes, remoteId, remote, conn, hop) {
  const entry = providerModelEntry({
    prefixes,
    modelId: remoteId,
    name: typeof remote?.name === "string" && remote.name ? remote.name : remoteId,
    provider: remote?.provider && typeof remote.provider === "object"
      ? remote.provider
      : listingProvider(REMOTE_ROUTER_ID, prefixes.prefix, conn),
  });
  const remoteAliases = Array.isArray(remote?.aliases) ? remote.aliases.filter((a) => typeof a === "string" && a) : [];
  const aliases = [...(entry.aliases || []), ...remoteAliases.map((a) => `${prefixes.prefix}/${a}`)];
  if (aliases.length) entry.aliases = aliases;
  if (Array.isArray(remote?.variants)) {
    entry.variants = remote.variants
      .filter((v) => typeof v?.id === "string" && v.id)
      .map((v) => ({
        ...v,
        id: `${prefixes.prefix}/${v.id}`,
        ...(Array.isArray(v.aliases) ? { aliases: v.aliases.map((a) => `${prefixes.prefix}/${a}`) } : {}),
      }));
  }
  entry.via = REMOTE_ROUTER_ID;
  entry.route = [hop, ...(Array.isArray(remote?.route) ? remote.route : [])];
  return entry;
}

// Map per-model `type` field (in PROVIDER_MODELS) to service kind.
// Models without `type` are treated as LLM.
const MODEL_TYPE_TO_KIND = {
  image: "image",
  tts: "tts",
  embedding: "embedding",
  stt: "stt",
  imageToText: "imageToText",
  video: "video",
  systemOne: "systemone",
  systemone: "systemone",
  textClassification: "systemone",
  evaluation: "systemone",
};

function modelKind(model) {
  const k = model?.kind || model?.type;
  if (!k) return LLM_KIND;
  return MODEL_TYPE_TO_KIND[k] || LLM_KIND;
}

// For dynamic/unknown model IDs (compatible providers, alias map, custom models)
// fall back to provider-level kind matching when per-model type is unavailable.
function inferKindFromUnknownModelId(modelId) {
  const lower = String(modelId).toLowerCase();
  if (/embed/.test(lower)) return "embedding";
  if (/tts|speech|audio|voice/.test(lower)) return "tts";
  if (/image|imagen|dall-?e|flux|sdxl|sd-|stable-diffusion/.test(lower)) return "image";
  return LLM_KIND;
}

async function fetchCompatibleModelIds(connection) {
  if (!connection?.apiKey) return [];

  const baseUrl = typeof connection?.providerSpecificData?.baseUrl === "string"
    ? connection.providerSpecificData.baseUrl.trim().replace(/\/$/, "")
    : "";

  if (!baseUrl) return [];

  let url = `${baseUrl}/models`;
  const headers = {
    "Content-Type": "application/json",
  };

  if (isOpenAICompatibleProvider(connection.provider)) {
    headers.Authorization = `Bearer ${connection.apiKey}`;
  } else if (isAnthropicCompatibleProvider(connection.provider)) {
    if (url.endsWith("/messages/models")) {
      url = url.slice(0, -9);
    } else if (url.endsWith("/messages")) {
      url = `${url.slice(0, -9)}/models`;
    }
    headers["x-api-key"] = connection.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers.Authorization = `Bearer ${connection.apiKey}`;
  } else {
    return [];
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, {
      method: "GET",
      headers: { ...headers, [INTERNAL_MODELS_FETCH_HEADER]: "1" },
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) return [];

    const data = await response.json();
    const rawModels = parseOpenAIStyleModels(data);

    return Array.from(
      new Set(
        rawModels
          .map((model) => model?.id || model?.name || model?.model)
          .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "")
      )
    );
  } catch {
    return [];
  }
}

// Provider matches kindFilter when its serviceKinds intersect the requested kinds.
// LLM is the default kind for providers missing serviceKinds.
function providerMatchesKinds(providerId, kindFilter) {
  const provider = AI_PROVIDERS[providerId];
  const kinds = Array.isArray(provider?.serviceKinds) && provider.serviceKinds.length > 0
    ? provider.serviceKinds
    : [LLM_KIND];
  return kindFilter.some((k) => kinds.includes(k));
}

// Combo matches kindFilter when its `kind` field is in the list.
// Combos with no kind are treated as LLM.
function comboMatchesKinds(combo, kindFilter) {
  const kind = combo?.kind || LLM_KIND;
  return kindFilter.includes(kind);
}

// Boolean capability flags are unioned across members (OR): a feature is
// available to the combo if any member supports it.
const COMBO_BOOLEAN_CAPS = [
  "vision", "pdf", "audioInput", "videoInput", "imageOutput",
  "audioOutput", "search", "tools", "reasoning", "thinkingEffortSupported",
];
// Restrictions hold for the combo as soon as one member has them (AND of the
// permission): any member may serve the request.
const COMBO_ALL_MEMBERS_CAPS = ["thinkingCanDisable", "forcedToolChoice"];

/**
 * Aggregate capabilities across a combo's member models so the /v1/models entry
 * carries the same shape as a concrete model. Numeric limits are the MINIMUM
 * across members (a request can route to any member, so the combo is bounded by
 * the smallest window); boolean features are the UNION; format scalars take the
 * first non-null. Nested combos are flattened (mirrors the chat path, which
 * re-expands a bare combo name as a single model). `seen` guards against cycles.
 * @param {string[]} memberStrings - combo.models entries (provider/model, alias, or nested combo name)
 * @param {Map<string,object>} comboByName - name -> combo, for nested expansion
 * @param {Set<string>} [seen] - names already visited (cycle guard)
 * @returns {object|null} merged capabilities, or null if no resolvable members
 */
function mergeComboCapabilities(memberStrings, comboByName, seen = new Set()) {
  if (!Array.isArray(memberStrings) || memberStrings.length === 0) return null;

  const merged = { ...DEFAULT_CAPABILITIES };
  let resolvedAny = false;
  let seenFinite = false;

  for (const member of memberStrings) {
    if (typeof member !== "string") continue;

    let caps;
    if (member.includes("/")) {
      const { provider, model } = parseModel(member);
      // Members may carry a thinking suffix ("model(high)") — resolve via clean id.
      caps = getCapabilitiesForModel(provider, stripThinkingSuffix(model));
    } else if (comboByName.has(member)) {
      if (seen.has(member)) continue; // cycle guard
      seen.add(member);
      caps = mergeComboCapabilities(comboByName.get(member).models, comboByName, seen);
    } else {
      caps = getCapabilitiesForModel(null, stripThinkingSuffix(member));
    }
    if (!caps) continue;

    for (const key of COMBO_BOOLEAN_CAPS) {
      if (caps[key]) merged[key] = true;
    }
    for (const key of COMBO_ALL_MEMBERS_CAPS) {
      if (caps[key] === false) merged[key] = false;
    }
    if (merged.thinkingFormat === null && caps.thinkingFormat != null) merged.thinkingFormat = caps.thinkingFormat;
    if (merged.thinkingRange === null && caps.thinkingRange != null) merged.thinkingRange = caps.thinkingRange;
    if (Number.isFinite(caps.contextWindow)) {
      merged.contextWindow = seenFinite ? Math.min(merged.contextWindow, caps.contextWindow) : caps.contextWindow;
    }
    if (Number.isFinite(caps.maxOutput)) {
      merged.maxOutput = seenFinite ? Math.min(merged.maxOutput, caps.maxOutput) : caps.maxOutput;
    }
    resolvedAny = true;
    seenFinite = true;
  }

  return resolvedAny ? merged : null;
}

/**
 * The provider/model members a combo can route to, nested combos expanded, in order
 * and without duplicates. A thinking suffix ("model(high)") is kept: it is part of
 * the member the router calls.
 */
function comboMembers(memberStrings, comboByName, seen = new Set()) {
  const out = [];
  for (const member of Array.isArray(memberStrings) ? memberStrings : []) {
    if (typeof member !== "string" || !member) continue;
    if (member.includes("/")) {
      if (!out.includes(member)) out.push(member);
    } else if (comboByName.has(member) && !seen.has(member)) {
      seen.add(member);
      for (const nested of comboMembers(comboByName.get(member).models, comboByName, seen)) {
        if (!out.includes(nested)) out.push(nested);
      }
    }
  }
  return out;
}

/** parameters of one provider/model member (thinking suffix resolved to the clean id). */
function memberParameters(member) {
  const { provider, model } = parseModel(member);
  const clean = stripThinkingSuffix(model);
  return modelParameters(getCapabilitiesForModel(provider, clean), getThinkingLevelsForId(provider, model));
}

/**
 * The active accounts one caller's catalog is built from: those an API key is bound
 * to, and, when resources are scoped by user, those its owner may use. A dashboard
 * caller passes its `scopeFilter` (null sees everything, `{ owner }` that owner's and
 * the shared pool) in place of an API key.
 * @param {object} options - { apiKey, scopeFilter }
 */
/**
 * Thinking levels, members and the parameters a client must respect, for an LLM
 * combo (or a flat model id, which is an implicit fallback combo over its offers).
 */
function addComboRouting(entry, memberStrings, comboByName) {
  const comboLevels = comboThinkingLevels(memberStrings);
  if (comboLevels) entry.thinking_levels = comboLevels;
  // What the router may call, and the parameters a client must respect for
  // whichever member serves (strictest member; see mergeModelParameters).
  const members = comboMembers(memberStrings, comboByName);
  if (!members.length) return;
  entry.members = members;
  const perMember = members.map((id) => ({ id, parameters: memberParameters(id) }));
  const strict = mergeModelParameters(perMember.map((m) => m.parameters));
  // A fallback combo is served by its lead unless the lead fails, so the lead's
  // parameters are what a client should plan for; X-RedRouter-Served-Model says
  // when another member answered, and member_parameters has that member's. Any
  // other strategy may land on any member: the strictest member's apply.
  const lead = entry.strategy === "fallback" ? perMember[0].parameters : null;
  const parameters = lead || strict;
  if (parameters) {
    entry.parameters = parameters;
    entry.parameters_basis = lead ? "lead" : "strictest";
    if (lead && strict) entry.parameters_strict = strict;
  }
  entry.member_parameters = perMember;
}

export async function catalogConnections(options = {}) {
  let connections = [];
  try {
    connections = await getProviderConnections();
    connections = connections.filter(c => c.isActive !== false);
  } catch (e) {
    console.log("Could not fetch providers, returning all models");
  }

  // A key bound to specific accounts only sees those accounts' providers. The
  // empty result is meaningful here (unlike an unreachable DB), so it must not
  // fall through to the static full catalog below.
  const allowedConnectionIds = await getApiKeyAllowedConnectionIds(options.apiKey || null);
  if (allowedConnectionIds) connections = connections.filter((c) => allowedConnectionIds.includes(c.id));

  // Ownership: the catalog must not reveal accounts or combos of other users.
  let keyOwner = null;
  let scoped = false;
  let settings = null;
  const viewer = options.scopeFilter;
  try {
    settings = await getSettings();
    scoped = viewer === undefined ? settings?.scopeResourcesByUser === true : viewer !== null;
    if (scoped) {
      keyOwner = viewer === undefined ? await getApiKeyOwner(options.apiKey || null) : viewer.owner ?? null;
      connections = connections.filter((c) => !c.owner || c.owner === keyOwner);
      // A shared account the user switched off for themselves must not show up
      // in their catalogue either, or it would advertise models they cannot reach.
      if (keyOwner) {
        const { getDisabledAccountIds } = await import("@/lib/db/repos/disabledAccountsRepo.js");
        const disabled = new Set(await getDisabledAccountIds(keyOwner));
        if (disabled.size) connections = connections.filter((c) => !disabled.has(c.id));
      }
    }
  } catch { }

  return { connections, allowedConnectionIds, settings, scoped, keyOwner };
}

/**
 * Build OpenAI-format models list filtered by service kinds.
 * @param {string[]} kindFilter - List of service kinds to include (e.g. ["llm"], ["webSearch","webFetch"]).
 * @param {object} options - { skipDynamicFetch, apiKey, scopeFilter, variants } — `apiKey`
 *   narrows the catalog to the providers of the accounts it is bound to (unbound = all);
 *   see catalogConnections for `scopeFilter`.
 */
export async function buildModelsList(kindFilter, options = {}) {
  // When this header is present, the /v1/models request came from another
  // red-router instance's fetchCompatibleModelIds — skip dynamic fetch to break
  // cross-instance recursive loops.
  const skipDynamicFetch = options.skipDynamicFetch === true;
  // The routers this catalog request already passed (x-red-router-chain). Remote
  // RedRouter catalogs are fetched with this router appended; none when that would
  // loop or exceed the hop limit.
  const chain = parseRedRouterChain(options.chain);
  const remoteChain = skipDynamicFetch ? null : nextRouterChain(chain);
  const { connections, allowedConnectionIds, settings, scoped, keyOwner } = await catalogConnections(options);

  const prefixStyle = catalogPrefixStyle(settings);
  const variantsMode = catalogVariantsMode(settings, options.variants);

  let combos = [];
  try {
    combos = await getCombos();
    if (scoped) combos = combos.filter((c) => !c.owner || c.owner === keyOwner);
  } catch (e) {
    console.log("Could not fetch combos");
  }
  // Name -> combo, used to flatten nested combos when merging capabilities.
  const comboByName = new Map(combos.map((c) => [c.name, c]));

  let customModels = [];
  try {
    customModels = await getCustomModels();
  } catch (e) {
    console.log("Could not fetch custom models");
  }

  let modelAliases = {};
  try {
    modelAliases = await getModelAliases();
  } catch (e) {
    console.log("Could not fetch model aliases");
  }

  let disabledByAlias = {};
  try {
    disabledByAlias = await getDisabledModels();
  } catch (e) {
    console.log("Could not fetch disabled models");
  }
  const isDisabled = (alias, modelId) => Array.isArray(disabledByAlias[alias]) && disabledByAlias[alias].includes(modelId);

  let displayNames = {};
  try {
    displayNames = (await getModelDisplayNames()) || {};
  } catch (e) {
    console.log("Could not fetch model display names");
  }
  // A user's name for a provider model outranks the catalog's.
  const displayNameOf = (providerId, modelId, fallback) => displayNames[`${providerId}/${modelId}`] || fallback;

  const connectionsByProvider = new Map();
  for (const conn of connections) {
    connectionsByProvider.set(conn.provider, [...(connectionsByProvider.get(conn.provider) || []), conn]);
  }
  const listings = [...connectionsByProvider].flatMap(([providerId, providerConnections]) => (
    providerListings(providerId, providerConnections, prefixStyle).map((listing) => ({ providerId, ...listing }))
  ));

  const models = [];

  // Combos first (filtered by kind). Web combos expose `kind` so AI knows search vs fetch.
  for (const combo of combos) {
    if (!comboMatchesKinds(combo, kindFilter)) continue;
    const entry = {
      id: combo.name,
      object: "model",
      owned_by: "combo",
      name: combo.name,
      provider: COMBO_PROVIDER,
      // How the gateway walks the members (fallback, round-robin, fusion, smart, auto).
      strategy: comboStrategyFor(settings, combo.name),
    };
    if (combo.kind === "webSearch" || combo.kind === "webFetch") {
      entry.kind = combo.kind;
    } else {
      // Merge capabilities from member models so clients see a context window
      // and feature set for the combo (bounded by its smallest-window member).
      const caps = mergeComboCapabilities(combo.models, comboByName);
      if (caps) {
        entry.capabilities = caps;
        entry.context_length = caps.contextWindow;
        entry.max_completion_tokens = caps.maxOutput;
      }
    }
    // LLM combos can only honor thinking levels every member supports (weakest
    // member rule); limits and capabilities come from mergeComboCapabilities above.
    if ((combo?.kind || LLM_KIND) === LLM_KIND) addComboRouting(entry, combo.models, comboByName);
    models.push(entry);
  }

  if (connections.length === 0 && !allowedConnectionIds) {
    // DB unavailable -> return static models, filtered by per-model kind
    const aliasToProviderId = Object.fromEntries(
      Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id])
    );
    for (const [alias, providerModels] of Object.entries(PROVIDER_MODELS)) {
      const providerId = aliasToProviderId[alias] || alias;
      if (!providerMatchesKinds(providerId, kindFilter)) continue;
      const prefixes = listingPrefixes(providerId, prefixStyle);
      const provider = providerIdentity(providerId);
      const listedModels = providerModels
        .filter((model) => kindFilter.includes(modelKind(model)))
        .filter((model) => ![alias, prefixes.prefix, providerLegacyPrefix(providerId)].some((prefix) => isDisabled(prefix, model.id)));
      const nameOf = (id) => listedModels.find((m) => m.id === id)?.name || variantBaseName(providerId, id) || id;
      const collapsed = collapseVariants(providerId, listedModels.map((model) => model.id), variantsMode);
      for (const modelId of collapsed.ids) {
        const entry = providerModelEntry({ prefixes, modelId, name: displayNameOf(providerId, modelId, nameOf(modelId)), provider });
        const variants = collapsed.groups.get(modelId);
        if (variants) entry.variants = variantEntries(prefixes, variants, nameOf);
        models.push(entry);
      }
    }

    for (const customModel of customModels) {
      if (!customModel?.id || (customModel.type && customModel.type !== "llm")) continue;
      // Custom models without active connection are LLM-only by current schema
      if (!kindFilter.includes(LLM_KIND)) continue;
      const providerAlias = customModel.providerAlias;
      if (!providerAlias) continue;

      const modelId = String(customModel.id).trim();
      if (!modelId) continue;

      const providerId = resolveProviderAlias(providerAlias);
      const provider = providerIdentity(providerId);
      const prefixes = provider ? listingPrefixes(providerId, prefixStyle) : { prefix: providerAlias, others: [] };
      models.push(providerModelEntry({ prefixes, modelId, name: customModel.name, provider }));
    }
  } else {
    for (const { providerId, conn, prefixes, connections: prefixConnections } of listings) {
      if (!providerMatchesKinds(providerId, kindFilter)) continue;

      const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
      const outputAlias = prefixes.prefix;
      const provider = listingProvider(providerId, outputAlias, conn);
      // A prefix one account carries names that account; a prefix several accounts
      // share is a pool and names none of them.
      if (prefixConnections.length === 1) {
        provider.connection = { id: prefixConnections[0].id, name: connectionLabel(prefixConnections[0]) };
      }
      // Every prefix this provider's ids may carry in live catalogs, custom models,
      // model aliases and the disabled-models table (keyed by the dashboard's code).
      const ownPrefixes = [...new Set([outputAlias, staticAlias, providerId, providerSlug(providerId), providerLegacyPrefix(providerId)])];
      const stripOwnPrefix = (fullId) => {
        const slash = fullId.indexOf("/");
        return slash > 0 && ownPrefixes.includes(fullId.slice(0, slash)) ? fullId.slice(slash + 1) : fullId;
      };
      const providerModels = PROVIDER_MODELS[staticAlias] || [];
      const enabledModels = conn?.providerSpecificData?.enabledModels;
      const hasExplicitEnabledModels =
        Array.isArray(enabledModels) && enabledModels.length > 0;
      const isCompatibleProvider =
        isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);

      // Build kind lookup for static models so we can filter even when only IDs are exposed
      const staticModelKindById = new Map(
        providerModels.map((m) => [m.id, modelKind(m)])
      );
      let liveModelKindById = new Map();
      let liveCapabilitiesById = new Map();
      let liveModelById = new Map();

      let rawModelIds = hasExplicitEnabledModels
        ? Array.from(
            new Set(
              enabledModels.filter(
                (modelId) => typeof modelId === "string" && modelId.trim() !== "",
              ),
            ),
          )
        : providerModels.map((model) => model.id);

      if (isCompatibleProvider && rawModelIds.length === 0 && !skipDynamicFetch) {
        rawModelIds = await fetchCompatibleModelIds(conn);
      }

      // Config-driven live catalog override (e.g. Kiro returns dynamic
      // -thinking/-agentic variants per account). On failure, fall back to
      // whatever rawModelIds already holds.
      const liveResolver = providerId === REMOTE_ROUTER_ID
        ? (remoteChain
          ? (c) => syncRemoteRouterCatalog(c, { chain: remoteChain })
          : async () => ({ models: [] }))
        : LIVE_MODEL_RESOLVERS[providerId];
      let remoteInstance = null;
      if (liveResolver && !hasExplicitEnabledModels) {
        try {
          const live = await liveResolver(conn);
          if (live?.models?.length || (providerId === "red-router" && Array.isArray(live?.models))) {
            rawModelIds = live.models.map((m) => m.id);
            liveModelKindById = new Map(
              live.models
                .filter((m) => m?.id)
                .map((m) => [m.id, modelKind(m)])
            );
            liveCapabilitiesById = new Map(
              live.models
                .filter((m) => m?.id && m.capabilities)
                .map((m) => [m.id, m.capabilities])
            );
            liveModelById = new Map(live.models.filter((m) => m?.id).map((m) => [m.id, m]));
            remoteInstance = live.instanceId || null;
          }
        } catch (err) {
          console.log(`Live model fetch failed for ${providerId}: ${err?.message || err}`);
        }
      }

      const modelIds = rawModelIds
        .map((modelId) => (providerId === REMOTE_ROUTER_ID ? modelId : stripOwnPrefix(modelId)))
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const customModelKindById = new Map();
      const customModelNameById = new Map();
      const customModelIds = customModels
        .filter((m) => {
          if (!m?.id) return false;
          const kind = getModelKind(m) || LLM_KIND;
          // imageToText custom models are vision-capable chat models: expose them
          // both in the default LLM list and in /v1/models/image-to-text.
          if (!kindFilter.includes(kind) && !(kind === "imageToText" && kindFilter.includes(LLM_KIND))) return false;
          return ownPrefixes.includes(m.providerAlias);
        })
        .map((m) => {
          const modelId = String(m.id).trim();
          if (modelId) customModelKindById.set(modelId, getModelKind(m) || LLM_KIND);
          if (modelId && m.name) customModelNameById.set(modelId, m.name);
          return modelId;
        })
        .filter((modelId) => modelId !== "");

      const aliasModelIds = Object.values(modelAliases || {})
        .filter((fullModel) => typeof fullModel === "string" && fullModel.includes("/") && stripOwnPrefix(fullModel) !== fullModel)
        .map(stripOwnPrefix)
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const mergedModelIds = Array.from(new Set([...modelIds, ...customModelIds, ...aliasModelIds]))
        .filter((modelId) => !ownPrefixes.some((prefix) => isDisabled(prefix, modelId)));
      const collapsed = providerId === REMOTE_ROUTER_ID
        ? { ids: mergedModelIds, groups: new Map() }
        : collapseVariants(providerId, mergedModelIds, variantsMode);
      const nameOf = (modelId) => liveModelById.get(modelId)?.name
        || customModelNameById.get(modelId)
        || (staticModelKindById.has(modelId) ? findModelName(staticAlias, modelId) : null)
        || variantBaseName(providerId, modelId)
        || modelId;

      for (const modelId of collapsed.ids) {
        const variants = collapsed.groups.get(modelId);
        // A base listed in place of its variants takes their kind.
        const kindId = variants && !mergedModelIds.includes(modelId) ? variants[0].id : modelId;
        // Resolve kind: prefer custom/live metadata, then static, then ID heuristics.
        const customKind = customModelKindById.get(kindId);
        const liveKind = liveModelKindById.get(kindId);
        const kind = customKind || liveKind || staticModelKindById.get(kindId) || inferKindFromUnknownModelId(kindId);
        // imageToText custom models stay in the LLM list (vision-capable chat models)
        const allowAsLlm = kind === "imageToText" && kindFilter.includes(LLM_KIND);
        if (!kindFilter.includes(kind) && !allowAsLlm) continue;

        const model = providerId === REMOTE_ROUTER_ID
          ? remoteRouterEntry(prefixes, modelId, liveModelById.get(modelId), conn, routerHop(prefixes, remoteInstance, prefixConnections))
          : providerModelEntry({ prefixes, modelId, name: displayNameOf(providerId, modelId, nameOf(modelId)), provider });
        if (variants) model.variants = variantEntries(prefixes, variants, nameOf);
        // Live-catalog resolvers (kiro/qoder/github/clinepass) mostly only return
        // { id, name } — no per-model capability data. Fall back to the same
        // pattern-matched capabilities the dashboard uses (useModelCaps.js) so
        // dynamically-discovered LLM models still surface vision/reasoning/search/tools.
        const caps = liveCapabilitiesById.get(modelId)
          || capabilitiesFromServiceKind(customKind || liveKind)
          || (kind === LLM_KIND ? getCapabilitiesForModel(providerId, modelId) : null);
        if (caps) model.capabilities = caps;
        // Token limits under the snake_case names the OpenAI/OpenRouter
        // convention uses. `capabilities.contextWindow` is camelCase and nested,
        // so clients matching context_length find nothing, fall back to guessing
        // the window from the model name, and guess high — a 372k model read as
        // 1.05M never reaches its compaction threshold and hard-fails upstream.
        // Emitted at top level because not every client recurses into nested
        // objects; the camelCase `capabilities` block stays for compatibility.
        if (kind === LLM_KIND || allowAsLlm) {
          let contextWindow = caps?.contextWindow;
          let maxOutput = caps?.maxOutput;
          // Live-catalog and service-kind capabilities are usually partial
          // (often just { tools: true }), so fill the gaps from the static
          // table rather than emitting null and leaving clients to guess.
          if (!Number.isFinite(contextWindow) || !Number.isFinite(maxOutput)) {
            const fallback = getCapabilitiesForModel(providerId, modelId);
            if (!Number.isFinite(contextWindow)) contextWindow = fallback.contextWindow;
            if (!Number.isFinite(maxOutput)) maxOutput = fallback.maxOutput;
          }
          if (Number.isFinite(contextWindow)) model.context_length = contextWindow;
          if (Number.isFinite(maxOutput)) model.max_completion_tokens = maxOutput;
          // Levels a client may request (resolves via the clean id when the
          // entry carries a "(level)" suffix). Mirrored under capabilities.
          // A base entry also offers the levels its variant ids select, and the
          // modes (e.g. Codex review) only a variant id reaches.
          const variantLevels = variants?.some((v) => v.level) === true;
          const ownLevels = getThinkingLevelsForId(providerId, modelId);
          const levels = variants ? mergeVariantLevels(ownLevels, variants) : ownLevels;
          if (levels) {
            model.thinking_levels = levels;
            if (model.capabilities) model.capabilities.thinkingLevels = levels;
          }
          const baseCaps = { ...getCapabilitiesForModel(providerId, modelId), ...(caps || {}), contextWindow, maxOutput };
          if (variantLevels) baseCaps.reasoning = true;
          const parameters = modelParameters(baseCaps, levels);
          const modes = [...new Set((variants || []).map((v) => v.mode).filter(Boolean))];
          if (parameters && modes.length) parameters.modes = modes;
          if (parameters) model.parameters = parameters;
        }
        models.push(model);
      }

      // Web search/fetch — provider IS the model, expose as {alias}/search and/or {alias}/fetch with explicit kind
      const providerInfo = AI_PROVIDERS[providerId];
      if (kindFilter.includes("webSearch") && providerInfo?.searchConfig) {
        models.push(providerModelEntry({ prefixes, modelId: "search", name: `${provider.name} Search`, provider, extra: { kind: "webSearch" } }));
      }
      if (kindFilter.includes("webFetch") && providerInfo?.fetchConfig) {
        models.push(providerModelEntry({ prefixes, modelId: "fetch", name: `${provider.name} Fetch`, provider, extra: { kind: "webFetch" } }));
      }
    }
  }

  if (kindFilter.includes(SYSTEM_ONE_KIND)) {
    models.push(...await borrowedSystemOneEntries({ connections, prefixStyle, isDisabled, displayNameOf }));
    models.push(...await remoteRouterSystemOneEntries({ connections, prefixStyle, isDisabled, remoteChain }));
  }

  // User aliases ("fast" -> "codex/gpt-5.5") are entries of their own, listed when the
  // model they point at is in this catalog. A combo of the same name wins at routing
  // time, so dedupe below keeps the combo.
  let aliasNames = {};
  try {
    aliasNames = (await getModelAliasNames()) || {};
  } catch (e) {
    console.log("Could not fetch model alias names");
  }
  const providerEntries = models.filter((entry) => entry.provider?.id !== COMBO_PROVIDER.id);
  for (const [alias, target] of Object.entries(modelAliases || {})) {
    if (typeof target !== "string" || !target.includes("/") || alias.includes("/")) continue;
    const targetEntry = catalogEntryFor(providerEntries, target);
    if (targetEntry) {
      models.push(aliasEntry(alias, aliasNames[alias], targetEntry, target));
      continue;
    }
    // A target saved under a prefix no longer listed ("codex/<model>" once every Codex
    // account has its own prefix) still routes to the whole provider: describe it with
    // any listing of that model, without naming one account, and keep the saved id.
    const { provider: targetProvider, model: targetModel } = parseModel(target);
    const sameModel = providerEntries.find((entry) => entry.provider?.id === targetProvider
      && entry.id === `${entry.owned_by}/${targetModel}`);
    if (sameModel) {
      const entry = aliasEntry(alias, aliasNames[alias], sameModel, sameModel.id);
      if (entry.provider) delete entry.provider.connection;
      entry.alias_of = target;
      models.push(entry);
    }
  }

  const comboCreated = new Map(combos.map((c) => [c.name, Math.floor(Date.parse(c.createdAt) / 1000)]));
  const dedupedModels = [];
  const seenModelIds = new Set();
  for (const model of models) {
    if (!model?.id || seenModelIds.has(model.id)) continue;
    seenModelIds.add(model.id);
    dedupedModels.push(withCreated(model, comboCreated));
  }

  const allowed = await filterByKeyModelAccess(dedupedModels, options.apiKey);
  // Flat ids group the offers the key may use, so access is decided per offer first.
  return options.idFormat === "flat" ? flattenCatalog(allowed, comboByName, { keepEmpty: options.keepEmptyFlat === true }) : allowed;
}

/** Catalog id formats: "prefixed" lists every offer; "flat" one entry per model (src/lib/flatModels.js). */
export const ID_FORMATS = ["prefixed", "flat"];

const perMillionPrice = (pricing) => (pricing && (typeof pricing.input === "number" || typeof pricing.output === "number")
  ? { input: pricing.input ?? null, output: pricing.output ?? null }
  : null);

/**
 * Replace each LLM provider offer with its flat entry: an implicit fallback combo
 * whose members are the offers' full ids (cheapest first), shaped like a combo so
 * clients handle it the same way, plus `offers` for labels and pinning.
 */
async function flattenCatalog(entries, comboByName, { keepEmpty = false } = {}) {
  const isOffer = (e) => e?.provider && e.owned_by !== "combo" && e.owned_by !== "alias" && !e.kind;
  const offers = entries.filter(isOffer);
  const groups = await groupFlatOffers(offers, {
    priceOf: async (providerId, modelId) => perMillionPrice(await getPricingForModel(providerId, modelId).catch(() => null)),
  });
  const flatIds = new Set(groups.map((g) => g.id));
  let policies = {};
  try {
    policies = (await getSettings())?.flatModelPolicies || {};
  } catch {
    // No settings: default order, every offer on.
  }
  const flat = [];
  for (const group of groups) {
    const { offers: ordered, custom } = applyFlatPolicy(group.offers, policies[group.key]);
    const members = ordered.filter((o) => o.available).map((o) => o.id);
    // Every offer switched off: the model is not offered at all (the Models page
    // still lists it, so it can be switched back on).
    if (!members.length && !keepEmpty) continue;
    const entry = {
      id: group.id,
      object: "model",
      owned_by: "combo",
      flat: true,
      name: group.name,
      provider: COMBO_PROVIDER,
      strategy: "fallback",
      // "price": cheapest first (default); "custom": an admin ordered or switched off offers.
      offer_order: custom ? "custom" : "price",
      ...(group.canonical ? { canonical: group.canonical } : {}),
      offers: ordered.map((o) => ({
        id: o.id,
        pin_id: pinIdFor(o, flatIds),
        provider: o.provider,
        via: o.via,
        available: o.available,
        price: o.price,
        free: o.free,
      })),
    };
    const caps = mergeComboCapabilities(members, comboByName);
    if (caps) {
      entry.capabilities = caps;
      entry.context_length = caps.contextWindow;
      entry.max_completion_tokens = caps.maxOutput;
    }
    addComboRouting(entry, members, comboByName);
    flat.push(entry);
  }
  return [...entries.filter((e) => !isOffer(e)), ...flat];
}

/**
 * System One models reached with another provider's key: an OpenCode Go account
 * lists OpenCode Zen's JEV models under Zen's own ids, and /v1/systemone sends them
 * to Zen with that account's key. The `provider` block is Zen's, with `via` naming
 * the account type that lends the key. When the provider has an account of its own,
 * its listing comes first and the dedupe keeps that entry.
 */
async function borrowedSystemOneEntries({ connections, prefixStyle, isDisabled, displayNameOf }) {
  const entries = [];
  for (const [providerId, sources] of Object.entries(SYSTEM_ONE_CREDENTIAL_SOURCES)) {
    const lenders = connections.filter((c) => sources.includes(c.provider));
    if (!lenders.length) continue;
    const resolver = SYSTEM_ONE_LIVE_RESOLVERS[providerId];
    const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
    const served = resolver
      ? (await resolver().catch(() => null))?.models
      : null;
    const listed = (served || PROVIDER_MODELS[alias] || []).filter((m) => modelKind(m) === SYSTEM_ONE_KIND);
    const prefixes = listingPrefixes(providerId, prefixStyle);
    const ownPrefixes = [...new Set([prefixes.prefix, ...prefixes.others, alias, providerId])];
    const lender = providerIdentity(lenders[0].provider);
    for (const model of listed) {
      if (ownPrefixes.some((prefix) => isDisabled(prefix, model.id))) continue;
      const provider = { ...providerIdentity(providerId), via: { id: lender.id, name: lender.name } };
      if (lenders.length === 1) provider.connection = { id: lenders[0].id, name: connectionLabel(lenders[0]) };
      entries.push(providerModelEntry({
        prefixes,
        modelId: model.id,
        name: displayNameOf(providerId, model.id, model.name || model.id),
        provider,
      }));
    }
  }
  return entries;
}

/**
 * System One models of every remote RedRouter connection, read from that router's
 * own /v1/models/systemone and listed under the connection's prefix
 * ("red-router/opencode-zen/jev-1.13"). A remote that is itself connected to routers
 * lists theirs, so an id carries one prefix per router hop and `route` names each.
 * /v1/systemone strips this router's hop and forwards the rest.
 */
async function remoteRouterSystemOneEntries({ connections, prefixStyle, isDisabled, remoteChain }) {
  const routers = connections.filter((c) => c.provider === REMOTE_ROUTER_ID);
  if (!remoteChain || routers.length === 0) return [];
  const listings = providerListings(REMOTE_ROUTER_ID, routers, prefixStyle);
  const catalogs = await Promise.all(listings.map(({ conn }) => (
    syncRemoteRouterCatalog(conn, { kind: SYSTEM_ONE_KIND, chain: remoteChain }).catch(() => ({ models: [] }))
  )));
  return listings.flatMap(({ conn, prefixes, connections: prefixConnections }, index) => {
    const catalog = catalogs[index];
    const hop = routerHop(prefixes, catalog.instanceId || null, prefixConnections);
    const ownPrefixes = [prefixes.prefix, ...prefixes.others, REMOTE_ROUTER_ID];
    return catalog.models
      .filter((remote) => !ownPrefixes.some((prefix) => isDisabled(prefix, remote.id)))
      .map((remote) => remoteRouterEntry(prefixes, remote.id, remote, conn, hop));
  });
}

/** The chain a remote RedRouter catalog is fetched with, or null when this router may not add a hop. */
function nextRouterChain(chain) {
  try {
    return parseRedRouterChain(appendRedRouterHop(chain));
  } catch {
    return null;
  }
}

/** Every name a listed entry may be matched by in a key's model rules. */
function entryAccessNames(entry) {
  if (entry.owned_by === "combo") return [entry.id];
  const names = new Set();
  for (const id of [entry.id, ...(entry.aliases || [])]) {
    const slash = id.indexOf("/");
    if (slash <= 0) { names.add(id); continue; }
    const providerId = resolveProviderAlias(id.slice(0, slash));
    for (const name of modelAccessNames({ providerId, model: id.slice(slash + 1), requested: id })) names.add(name);
  }
  return [...names];
}

// A key with model rules only sees what it may call. Members of a combo it may
// call stay unlisted unless allowed on their own; the combo entry covers them.
async function filterByKeyModelAccess(models, apiKey) {
  if (!apiKey) return models;
  let modelAccess = null;
  try { ({ modelAccess } = await getApiKeyPolicy(apiKey)); } catch { return models; }
  if (!modelAccess) return models;
  const allowed = [];
  for (const entry of models) {
    if (!modelAccessAllows(modelAccess, entryAccessNames(entry))) continue;
    if (Array.isArray(entry.variants)) {
      const variants = entry.variants.filter((v) => !v?.id || modelAccessAllows(modelAccess, entryAccessNames({ id: v.id, aliases: v.aliases })));
      allowed.push(variants.length === entry.variants.length ? entry : { ...entry, variants });
    } else {
      allowed.push(entry);
    }
  }
  return allowed;
}

// OpenAI's Model object requires `created` (unix seconds). Provider catalogs carry no
// creation date, so everything but a combo gets one fixed instant: a clock value would
// change /v1/models, and with it X-RedRouter-Catalog-Version, on every call.
const CATALOG_CREATED = 1735689600; // 2025-01-01T00:00:00Z

function withCreated(entry, comboCreated) {
  if (Number.isInteger(entry.created)) return entry;
  const fromCombo = entry.owned_by === "combo" ? comboCreated.get(entry.id) : null;
  const { id, object, ...rest } = entry;
  return { id, object, created: Number.isInteger(fromCombo) && fromCombo > 0 ? fromCombo : CATALOG_CREATED, ...rest };
}

/**
 * A user alias as its own /v1/models entry: the target's provider, limits, levels and
 * parameters under the alias id, with `alias_of` naming the target's catalog id (the
 * variant's id when the alias points at a folded variant).
 */
function aliasEntry(alias, name, target, targetId) {
  const variant = target.id === targetId || target.aliases?.includes(targetId)
    ? null
    : target.variants?.find((v) => v.id === targetId || v.aliases?.includes(targetId));
  const entry = {
    id: alias,
    object: "model",
    owned_by: "alias",
    name: (typeof name === "string" && name.trim()) || alias,
    alias_of: variant?.id || target.id,
  };
  for (const key of ["provider", "capabilities", "context_length", "max_completion_tokens", "thinking_levels", "parameters"]) {
    if (target[key] !== undefined) entry[key] = structuredClone(target[key]);
  }
  return entry;
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models - OpenAI compatible models list (LLM/chat models only by default).
 * For other capabilities use /v1/models/{kind} (image, tts, stt, embedding, image-to-text, web).
 */
export async function GET(request) {
  try {
    const apiKey = extractApiKey(request);
    // ?variants=expand lists every variant id as its own entry (older clients).
    const variants = request?.url ? new URL(request.url).searchParams.get("variants") || undefined : undefined;
    // Another RedRouter reading this catalog sends its hop chain (see catalogFetchOptions).
    // ?id_format=flat|prefixed overrides the key's setting (Endpoint & Keys → the key).
    const requestedFormat = request?.url ? new URL(request.url).searchParams.get("id_format") : null;
    const idFormat = ID_FORMATS.includes(requestedFormat) ? requestedFormat : await getApiKeyModelIdFormat(apiKey);
    const data = await buildModelsList([LLM_KIND], { ...catalogFetchOptions(request), apiKey, variants, idFormat });
    const catalogVersion = await getCatalogVersion(apiKey);
    // Clients setting RedRouter up as a provider learn the key's role and where
    // its MCP server is from here, without another call (details: GET /v1/key).
    const keyRecord = apiKey ? await getApiKeyByKey(apiKey).catch(() => null) : null;
    // id_format says how ids are built, so clients never have to guess from their shape.
    return Response.json({ object: "list", id_format: idFormat, data }, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        [RED_ROUTER_INSTANCE_HEADER]: RED_ROUTER_INSTANCE_ID,
        ...(catalogVersion ? { [CATALOG_VERSION_HEADER]: catalogVersion } : {}),
        ...(keyRecord ? { "x-redrouter-key-role": keyRecord.role || "standard", "x-redrouter-mcp": "/v1/mcp" } : {}),
      },
    });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error", param: null, code: "internal_server_error" } },
      { status: 500 }
    );
  }
}

