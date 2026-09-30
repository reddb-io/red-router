/**
 * Marks a catalog request that must see the TRANSPARENT list (`provider/model`) even when the
 * effective policy hides providers. The router itself asks for it: to route a bare model name it has
 * to know which providers offer that model, scoped to the caller's key exactly as the public list is.
 *
 * A WeakSet, not a header or query parameter: an outside caller can never set it.
 */
const transparentRequests = new WeakSet<Request>();

export function markTransparentCatalogRequest<T extends Request>(request: T): T {
  transparentRequests.add(request);
  return request;
}

export function isTransparentCatalogRequest(request: Request): boolean {
  return transparentRequests.has(request);
}
