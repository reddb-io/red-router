export function getCacheHeader(headers: unknown, name: string): string | null {
  if (!headers) return null;
  const get = (headers as { get?: (key: string) => string | null }).get;
  if (typeof get === "function") return get.call(headers, name);
  if (typeof headers !== "object" || Array.isArray(headers)) return null;
  const key = name.toLowerCase();
  for (const [candidate, value] of Object.entries(headers)) {
    if (candidate.toLowerCase() === key && typeof value === "string") return value;
  }
  return null;
}

function hasDirective(value: string | null, name: string): boolean {
  return (value || "")
    .toLowerCase()
    .split(",")
    .some((item) => item.trim().split("=")[0] === name);
}

export function responseCacheBypassed(headers: unknown): boolean {
  const control = getCacheHeader(headers, "cache-control");
  return (
    getCacheHeader(headers, "x-omniroute-no-cache")?.toLowerCase() === "true" ||
    hasDirective(control, "no-cache") ||
    hasDirective(control, "no-store") ||
    hasDirective(getCacheHeader(headers, "pragma"), "no-cache")
  );
}

export function responseCacheWriteDisabled(headers: unknown): boolean {
  return (
    responseCacheBypassed(headers) ||
    getCacheHeader(headers, "x-omniroute-cache-no-store")?.toLowerCase() === "true"
  );
}

/** The legacy SQLite cache has no caller namespace or fuzzy-only lookup mode. */
export function canUseLegacyResponseCache(headers: unknown): boolean {
  return (
    !getCacheHeader(headers, "x-omniroute-cache-key") &&
    getCacheHeader(headers, "x-omniroute-cache-type")?.toLowerCase() !== "semantic"
  );
}
