import { createHash } from "node:crypto";

type CatalogEntry = Record<string, unknown>;

/**
 * Digest of the model catalog a key sees. A client that cached /v1/models (RedCode keeps model
 * parameters and names) re-reads it when this differs from the version it cached. `created` is
 * the catalog build time, not a model revision, so it is excluded: rebuilding an unchanged
 * catalog must not invalidate clients. 16 hex characters, as in RedRouter v0.33.0.
 */
export function computeCatalogVersion(models: readonly CatalogEntry[]): string {
  const stable = models.map(({ created: _created, ...model }) => model);
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}

/** The version of a serialized `{ data: [...] }` /v1/models body, or null when it is not one. */
export function catalogVersionFromBody(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { data?: unknown };
    return Array.isArray(parsed?.data)
      ? computeCatalogVersion(parsed.data as CatalogEntry[])
      : null;
  } catch {
    return null;
  }
}
