export const RED_ROUTER_PROVIDER_ID = "red-router";
export const RED_ROUTER_CHAIN_HEADER = "x-red-router-chain";
export const RED_ROUTER_MAX_HOPS = 8;

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

export function appendRedRouterHop(rawChain, instanceId = RED_ROUTER_INSTANCE_ID) {
  const chain = String(rawChain || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (chain.includes(instanceId)) {
    throw new Error("RedRouter routing loop detected");
  }
  if (chain.length >= RED_ROUTER_MAX_HOPS) {
    throw new Error(`RedRouter hop limit exceeded (${RED_ROUTER_MAX_HOPS})`);
  }
  return [...chain, instanceId].join(",");
}
