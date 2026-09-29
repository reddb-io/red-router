/**
 * The RedRouter <-> RedCode header contract (RedRouter v0.33.0). RedCode reads these to learn
 * which model answered, what it cost and when its cached model catalog is stale, and sends the
 * request headers to steer routing. Names are part of a public contract: do not rename them.
 * Request names are lowercase (as sent); response names are canonical-cased (as emitted).
 */

// Request: a client-side classification that stands in for the decision model's questions.
export const RED_ROUTER_HINT_HEADER = "x-red-router-hint";
// Request: "off" | "auto" | a reasoning level; per-request override of the reasoning autopilot.
export const RED_ROUTER_REASONING_HEADER = "x-red-router-reasoning";
// Request: "off" | "on"; opts a single request out of (or into) token saving.
export const RED_ROUTER_TOKEN_SAVER_HEADER = "x-red-router-token-saver";
// Request: "off" | "on" | a decision mode for System One routing.
export const RED_ROUTER_DECISION_HEADER = "x-red-router-decision";
// Request/response: router chaining. The chain lists instance ids already traversed.
export const RED_ROUTER_CHAIN_HEADER = "x-red-router-chain";
export const RED_ROUTER_INSTANCE_HEADER = "x-red-router-instance";

// Response, successful chat: the provider/model that actually answered (the combo member
// after fallback) and, when it can be priced, the USD cost of the turn.
export const RED_ROUTER_SERVED_MODEL_HEADER = "X-RedRouter-Served-Model";
export const RED_ROUTER_COST_HEADER = "X-RedRouter-Cost-USD";
// Response: digest of the model catalog the caller's key sees. A client that cached
// /v1/models re-reads it when this differs from the version it cached.
export const RED_ROUTER_CATALOG_VERSION_HEADER = "X-RedRouter-Catalog-Version";
// Response: what the reasoning autopilot (or the request header) chose.
export const RED_ROUTER_REASONING_RESPONSE_HEADER = "X-RedRouter-Reasoning";

// Response, failed routing: a machine-readable reason (model_disabled, model_not_allowed,
// api_key_limit, quota_exhausted, overloaded, ...) and, when known, the ISO instant a retry may
// succeed. The X-9Router-* names are the v0.33.0 spelling RedCode already reads; both are emitted
// with the same values.
export const RED_ROUTER_REASON_HEADER = "X-RedRouter-Reason";
export const RED_ROUTER_RETRY_AT_HEADER = "X-RedRouter-Retry-At";
export const LEGACY_ROUTING_REASON_HEADER = "X-9Router-Reason";
export const LEGACY_ROUTING_RETRY_AT_HEADER = "X-9Router-Retry-At";

export const RED_ROUTER_REQUEST_HEADERS = [
  RED_ROUTER_HINT_HEADER,
  RED_ROUTER_REASONING_HEADER,
  RED_ROUTER_TOKEN_SAVER_HEADER,
  RED_ROUTER_DECISION_HEADER,
  RED_ROUTER_CHAIN_HEADER,
] as const;

export const RED_ROUTER_RESPONSE_HEADERS = [
  RED_ROUTER_SERVED_MODEL_HEADER,
  RED_ROUTER_COST_HEADER,
  RED_ROUTER_CATALOG_VERSION_HEADER,
  RED_ROUTER_REASONING_RESPONSE_HEADER,
  RED_ROUTER_REASON_HEADER,
  RED_ROUTER_RETRY_AT_HEADER,
  LEGACY_ROUTING_REASON_HEADER,
  LEGACY_ROUTING_RETRY_AT_HEADER,
  "Retry-After",
] as const;
