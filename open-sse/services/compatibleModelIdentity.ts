/** Normalize only when a discovered/custom native identity supplies exact evidence. */
export function normalizeCompatibleModelId(
  requested: string,
  routingIds: readonly unknown[],
  declaredNativeIds: ReadonlySet<string>
): string {
  // A namespace equal to our local prefix still belongs to the upstream ID.
  if (declaredNativeIds.has(requested)) return requested;
  const prefixes = routingIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  const matches = new Set<string>();
  let candidate = requested;
  for (let depth = 0; depth < 32; depth++) {
    const prefix = prefixes.find((id) => candidate.startsWith(`${id}/`));
    if (!prefix) break;
    candidate = candidate.slice(prefix.length + 1);
    if (declaredNativeIds.has(candidate)) matches.add(candidate);
  }
  // Multiple native namespaces or no catalog evidence cannot justify rewriting.
  return matches.size === 1 ? [...matches][0] : requested;
}
