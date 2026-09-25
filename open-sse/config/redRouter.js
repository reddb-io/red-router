export const RED_ROUTER_PROVIDER_ID = "red-router";
export const RED_ROUTER_CHAIN_HEADER = "x-red-router-chain";
// Sent back on catalog responses so the router that fetched them knows which
// instance each re-exposed entry passes through (cycle detection in listings).
export const RED_ROUTER_INSTANCE_HEADER = "x-red-router-instance";
// Router-to-router forwards one request may take: "red-router/red-router/red-router/
// red-router/<provider>/<model>" is the deepest id a catalog lists.
export const RED_ROUTER_MAX_HOPS = 4;

const configuredInstanceId = typeof process !== "undefined"
  ? process.env?.REDROUTER_INSTANCE_ID?.trim()
  : "";

export const RED_ROUTER_INSTANCE_ID = configuredInstanceId ||
  globalThis.crypto?.randomUUID?.() ||
  `rr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function normalizeRedRouterBaseUrl(value) {
  let baseUrl = String(value || "").trim().replace(/\/+$/, "");
  for (const suffix of ["/chat/completions", "/responses", "/models"]) {
    if (baseUrl.endsWith(suffix)) {
      baseUrl = baseUrl.slice(0, -suffix.length).replace(/\/+$/, "");
      break;
    }
  }
  if (!baseUrl.endsWith("/v1") && !baseUrl.endsWith("/api/v1")) {
    baseUrl += "/v1";
  }
  return baseUrl;
}

export function redRouterEndpoint(baseUrl, path) {
  return `${normalizeRedRouterBaseUrl(baseUrl)}/${String(path || "").replace(/^\/+/, "")}`;
}

/**
 * The instance ids a chain header lists, first hop first. The one parser of the
 * header: routing, catalogs and System One read it through here.
 */
export function parseRedRouterChain(rawChain) {
  if (Array.isArray(rawChain)) return rawChain.filter((entry) => typeof entry === "string" && entry);
  return String(rawChain || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function appendRedRouterHop(rawChain, instanceId = RED_ROUTER_INSTANCE_ID) {
  const chain = parseRedRouterChain(rawChain);

  if (chain.includes(instanceId)) {
    throw new Error("RedRouter routing loop detected");
  }
  if (chain.length >= RED_ROUTER_MAX_HOPS) {
    throw new Error(`RedRouter hop limit exceeded (${RED_ROUTER_MAX_HOPS})`);
  }
  return [...chain, instanceId].join(",");
}

/**
 * The entries of a remote RedRouter's catalog this router may list. An entry the
 * remote re-exposes from its own upstream routers carries a `route` (one hop per
 * router, each with the `instance` it runs as). Dropped: an entry whose route comes
 * back to a router already in `chain` (the chain this router sends, itself last),
 * and one needing more router hops than the chain has left.
 * @param {object[]} entries - the remote catalog
 * @param {{ remoteInstance?: string|null, chain: string[] }} options
 */
export function routableRemoteEntries(entries, { remoteInstance = null, chain }) {
  const seen = new Set(chain);
  if (remoteInstance && seen.has(remoteInstance)) return [];
  return entries.filter((entry) => {
    const route = Array.isArray(entry?.route) ? entry.route : [];
    if (route.length + chain.length > RED_ROUTER_MAX_HOPS) return false;
    return !route.some((hop) => typeof hop?.instance === "string" && seen.has(hop.instance));
  });
}
