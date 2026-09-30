/** RedRouter endpoint identity; preserve the baseline's host and /v1 URL forms. */
export const RED_ROUTER_DEFAULT_BASE_URL = "http://127.0.0.1:25050/v1";
export const INTERNAL_MODELS_FETCH_HEADER = "x-rr-internal-models-fetch";

export function redRouterEndpoint(
  value: string,
  endpoint: "models" | "chat/completions" | "systemone" | "decisions"
): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid remote router URL");
  }
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/(?:chat\/completions|responses|models|systemone|decisions)$/, "");
  if (!path.endsWith("/v1")) path += "/v1";
  url.pathname = `${path}/${endpoint}`;
  return url.href;
}
