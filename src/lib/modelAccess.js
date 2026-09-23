import { getDisabledModels, getApiKeyPolicy } from "@/lib/db/index.js";
import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { providerLegacyPrefix, providerSlug } from "open-sse/providers/identity.js";
import { stripThinkingSuffix } from "open-sse/translator/concerns/thinkingUnified.js";

export { normalizeModelAccess, MODEL_ACCESS_MODES } from "@/lib/apiKeyPolicy.js";

// Who may call which model. Two independent gates, checked where a request has
// resolved to a concrete provider/model (and again for every combo member):
//   1. the dashboard's disabled-models table, which applies to everyone;
//   2. the calling API key's model rules ({ mode: "allow"|"deny", patterns }).
// A denial is a routing candidate (reason + status) so combos skip the member
// and single-model requests answer 403 in the client's error format.

const globCache = new Map();

/** Case-insensitive glob: `*` matches any run of characters (slashes too), `?` one. */
export function globToRegExp(pattern) {
  let re = globCache.get(pattern);
  if (!re) {
    const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    re = new RegExp(`^${body}$`, "i");
    if (globCache.size > 1000) globCache.clear();
    globCache.set(pattern, re);
  }
  return re;
}

function matchesAny(patterns, names) {
  return patterns.some((pattern) => {
    const re = globToRegExp(pattern);
    return names.some((name) => re.test(name));
  });
}

/** Every prefix a provider's models may be written or stored under. */
export function providerPrefixes(providerId) {
  if (!providerId) return [];
  return [...new Set([PROVIDER_ID_TO_ALIAS[providerId], providerId, providerSlug(providerId), providerLegacyPrefix(providerId)].filter(Boolean))];
}

/**
 * The names one request may be matched by: what the client sent (an alias or a
 * combo member string), the bare model, and `prefix/model` for every prefix of
 * the provider, so a rule on any spelling of the model catches all of them.
 */
export function modelAccessNames({ providerId = null, model = null, requested = null } = {}) {
  const names = new Set();
  const add = (value) => { if (typeof value === "string" && value) names.add(value); };
  add(requested);
  if (requested) add(stripThinkingSuffix(requested));
  const models = model ? [...new Set([model, stripThinkingSuffix(model)])] : [];
  for (const m of models) {
    add(m);
    for (const prefix of providerPrefixes(providerId)) add(`${prefix}/${m}`);
  }
  return [...names];
}

/**
 * Whether rules let a request through. `grantedByCombo` is set when the key's
 * allow list names the combo being expanded: allowing a combo allows what it
 * calls. Deny rules still apply to members.
 */
export function modelAccessAllows(access, names, { grantedByCombo = false } = {}) {
  if (!access) return true;
  if (access.mode === "deny") return !matchesAny(access.patterns, names);
  if (access.mode === "allow") return grantedByCombo || matchesAny(access.patterns, names);
  return true;
}

/** Whether the dashboard disabled this provider's model (keyed by any of its prefixes). */
export function isDisabledIn(disabledByAlias, providerId, model) {
  if (!disabledByAlias || !providerId || !model) return false;
  const ids = new Set([model, stripThinkingSuffix(model)]);
  return providerPrefixes(providerId).some((prefix) => {
    const list = disabledByAlias[prefix];
    return Array.isArray(list) && list.some((id) => ids.has(id));
  });
}

export async function isModelDisabled(providerId, model) {
  let disabled = {};
  try { disabled = await getDisabledModels(); } catch { return false; }
  return isDisabledIn(disabled, providerId, model);
}

function denial(reason, providerId, model, message) {
  return { reason, provider: providerId || undefined, model: model || undefined, status: 403, errorType: "permission_error", message, retryable: false, retryAtMs: null };
}

/**
 * Null when the request may proceed, else a routing candidate to answer with.
 * Call it once the request has resolved to a concrete provider/model.
 */
export async function checkModelAccess({ apiKey = null, providerId, model, requested = null, grantedByCombo = false }) {
  if (await isModelDisabled(providerId, model)) {
    return denial("model_disabled", providerId, model, `Model ${requested || model} is disabled`);
  }
  if (!apiKey) return null;
  const { modelAccess } = await getApiKeyPolicy(apiKey);
  if (!modelAccessAllows(modelAccess, modelAccessNames({ providerId, model, requested }), { grantedByCombo })) {
    return denial("model_not_allowed", providerId, model, `This API key may not use model ${requested || model}`);
  }
  return null;
}

/**
 * Key rules for a combo name before it expands. `denial` blocks the whole combo;
 * `granted` tells members they are covered by the combo's allow entry.
 */
export async function checkComboAccess(apiKey, comboName) {
  if (!apiKey || !comboName) return { denial: null, granted: false };
  const { modelAccess } = await getApiKeyPolicy(apiKey);
  if (!modelAccess) return { denial: null, granted: false };
  const names = modelAccessNames({ requested: comboName });
  if (!modelAccessAllows(modelAccess, names)) {
    return { denial: denial("model_not_allowed", null, comboName, `This API key may not use model ${comboName}`), granted: false };
  }
  return { denial: null, granted: modelAccess.mode === "allow" };
}
