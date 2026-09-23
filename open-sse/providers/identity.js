// Provider identity: the readable slug /v1/models lists ids under, and every token a
// client may put before the "/" of a model id. Legacy short codes stay routable forever,
// so a model id a client saved years ago keeps resolving.
import REGISTRY from "./registry/index.js";

// Categories whose accounts are a subscription or free plan rather than metered API keys.
const SUBSCRIPTION_CATEGORIES = new Set(["oauth", "webCookie", "free"]);

// A token that two providers declare resolves by this precedence, highest first: a
// provider's own id never loses to another provider's alias.
const TOKEN_SOURCES = [
  (r) => [r.id],
  (r) => [r.slug],
  (r) => [r.alias],
  (r) => r.aliases || [],
  (r) => [r.uiAlias],
];

const BY_ID = new Map(REGISTRY.map((r) => [r.id, r]));

/** token (id, slug, alias, aliases[], uiAlias) -> provider id. */
export const PROVIDER_TOKEN_TO_ID = new Map();
for (const tokensOf of TOKEN_SOURCES) {
  for (const entry of REGISTRY) {
    for (const token of tokensOf(entry)) {
      if (token && !PROVIDER_TOKEN_TO_ID.has(token)) PROVIDER_TOKEN_TO_ID.set(token, entry.id);
    }
  }
}

/** The readable prefix of a built-in provider; unknown ids are their own slug. */
export function providerSlug(providerId) {
  return BY_ID.get(providerId)?.slug || providerId;
}

/** The short code a provider was listed under before slugs (the dashboard badge). */
export function providerLegacyPrefix(providerId) {
  const entry = BY_ID.get(providerId);
  return entry ? entry.uiAlias || entry.alias || entry.id : providerId;
}

/**
 * The `provider` block of a /v1/models entry, or null for an id outside the registry.
 * `subscription` is true when the account is a plan (OAuth, web cookie, free) rather
 * than a metered API key.
 */
export function providerIdentity(providerId) {
  const entry = BY_ID.get(providerId);
  if (!entry) return null;
  return {
    id: entry.id,
    slug: entry.slug || entry.id,
    prefix: providerLegacyPrefix(entry.id),
    name: entry.display?.name || entry.id,
    category: entry.category,
    subscription: SUBSCRIPTION_CATEGORIES.has(entry.category),
  };
}

/**
 * The model prefix a user gave one connection of a built-in provider ("codex-work"),
 * or "" when it has none. Custom-node connections carry their node prefix in the same
 * field; that prefix belongs to the node, so it is not a connection prefix.
 */
export function connectionModelPrefix(connection) {
  if (!connection || !BY_ID.has(connection.provider)) return "";
  const prefix = connection.providerSpecificData?.prefix;
  return typeof prefix === "string" ? prefix.trim() : "";
}
