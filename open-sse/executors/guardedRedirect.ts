/** Follow provider redirects only after validating every destination.
 * Inspired by OmniRoute #19096; adapted for RedRouter's existing fetch transports.
 */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie)$|key|token|secret/i;
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language"];

export async function guardedProviderFetch(
  url: string,
  init: RequestInit,
  validate: (url: string) => void,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  validate(url);
  // Callers that explicitly reject redirects or inspect them themselves retain that contract.
  if (init.redirect === "error" || init.redirect === "manual") return fetchImpl(url, init);

  let current = url;
  let options: RequestInit = { ...init, redirect: "manual" };
  for (let hop = 0; ; hop++) {
    const response = await fetchImpl(current, options);
    const location = response.headers.get("location");
    if (!REDIRECTS.has(response.status) || !location) return response;
    void response.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new Error("Provider redirect limit exceeded");
    const next = new URL(location, current).toString();
    validate(next);
    const headers = new Headers(options.headers);
    const changesOrigin = new URL(current).origin !== new URL(next).origin;
    if (changesOrigin) {
      for (const name of [...headers.keys()]) {
        if (SENSITIVE_HEADER.test(name)) headers.delete(name);
      }
    }
    const method = (options.method || "GET").toUpperCase();
    const switchToGet =
      response.status === 303 ? method !== "HEAD" : response.status <= 302 && method === "POST";
    // Even without credentials, a prompt or tool result in the body can be sensitive.
    if (changesOrigin && !switchToGet && options.body != null) {
      throw new Error("Cross-origin provider redirects cannot replay a request body");
    }
    if (switchToGet) {
      for (const name of BODY_HEADERS) headers.delete(name);
      options = { ...options, method: "GET", body: undefined, headers };
    } else {
      if (options.body instanceof ReadableStream) {
        throw new Error("Cannot replay a streaming request body after a provider redirect");
      }
      options = { ...options, headers };
    }
    current = next;
  }
}
