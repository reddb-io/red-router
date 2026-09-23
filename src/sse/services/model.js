// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes, getProviderConnections } from "@/lib/localDb";
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore, resolveProviderAlias } from "open-sse/services/model.js";
import { withThinkingSuffix } from "open-sse/services/combo.js";
import { PROVIDER_TOKEN_TO_ID, connectionModelPrefix } from "open-sse/providers/identity.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

// Every built-in provider token (id, slug, alias, aliases[], uiAlias) outranks a
// user-defined provider-node prefix: /v1/models lists built-in models under these.
const RESERVED_PROVIDER_PREFIXES = new Set([...Object.keys(LOCAL_PROVIDER_ALIASES), ...PROVIDER_TOKEN_TO_ID.keys()]);

/**
 * The built-in provider a prefix token names (registry id, slug, alias, aliases[],
 * uiAlias, media-only and local aliases, dashboard provider ids), or null. User-chosen
 * prefixes may never take one of these.
 */
export function builtInProviderForToken(token) {
  if (!token) return null;
  if (LOCAL_PROVIDER_ALIASES[token]) return LOCAL_PROVIDER_ALIASES[token];
  if (PROVIDER_TOKEN_TO_ID.has(token)) return PROVIDER_TOKEN_TO_ID.get(token);
  const resolved = resolveProviderAlias(token);
  if (resolved !== token) return resolved;
  return AI_PROVIDERS[token] ? token : null;
}

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr, comboOwner = undefined) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Provider-node prefixes are user-defined. They must not override built-in
    // provider ids/aliases such as `cf`, `cloudflare-ai`, `openai`, or `hf`.
    if (!RESERVED_PROVIDER_PREFIXES.has(parsed.providerAlias)) {
      const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
      const matchedOpenAI = openaiNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedOpenAI) {
        return { provider: matchedOpenAI.id, model: parsed.model };
      }

      const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
      const matchedAnthropic = anthropicNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedAnthropic) {
        return { provider: matchedAnthropic.id, model: parsed.model };
      }

      const embeddingNodes = await getProviderNodes({ type: "custom-embedding" });
      const matchedEmbedding = embeddingNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedEmbedding) {
        return { provider: matchedEmbedding.id, model: parsed.model };
      }

      // A prefix the user gave connections of a built-in provider ("codex-work/<model>")
      // routes to that provider and only to those accounts.
      const pinned = await connectionsForPrefix(parsed.providerAlias);
      if (pinned) {
        return { provider: pinned.provider, model: parsed.model, connectionIds: pinned.connectionIds };
      }
    }
    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model, comboOwner);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  // A user alias resolves through the same prefixes as a model id, so it may target a
  // custom node or a connection prefix ("work" -> "codex-work/gpt-5.5").
  const aliases = await getModelAliases();
  const target = aliases?.[parsed.model];
  if (typeof target === "string" && target.includes("/")) return getModelInfo(target, comboOwner);
  return getModelInfoCore(modelStr, aliases);
}

/** The provider and connection ids a connection model prefix names, or null. */
async function connectionsForPrefix(token) {
  const matches = ((await getProviderConnections()) || []).filter((conn) => connectionModelPrefix(conn) === token);
  if (matches.length === 0) return null;
  // Validation keeps a prefix on one provider; should two ever share it, the first wins.
  const provider = matches[0].provider;
  return { provider, connectionIds: matches.filter((conn) => conn.provider === provider).map((conn) => conn.id) };
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr, comboOwner = undefined) {
  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  const combo = await getComboByName(modelStr, comboOwner);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

/**
 * Check if model is a combo (exact name or with a thinking suffix) and resolve
 * its members. "my-combo(high)" re-attaches the override to members without
 * their own suffix; comboName is the clean DB name (for strategy/settings keys).
 * @returns {Promise<{models: string[], comboName: string, suffix: string}|null>}
 */
export async function resolveComboModels(modelStr, comboOwner = undefined) {
  if (typeof modelStr !== "string" || modelStr.includes("/")) return null;
  const direct = await getComboByName(modelStr, comboOwner);
  if (direct && direct.models && direct.models.length > 0) {
    return { models: direct.models, comboName: modelStr, suffix: "" };
  }
  const match = modelStr.match(/^(.*)\(([^()]+)\)\s*$/);
  if (!match) return null;
  const cleanName = match[1].trim();
  const combo = await getComboByName(cleanName);
  if (!combo || !combo.models || combo.models.length === 0) return null;
  const suffix = `(${match[2]})`;
  return { models: withThinkingSuffix(combo.models, suffix), comboName: cleanName, suffix };
}
