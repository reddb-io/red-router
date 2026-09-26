/** Pure source parsers for the read-only upstream parity inventory. */
export function providerId(source, file) {
  // Local registry files may declare model arrays before the RegistryEntry.
  // Their first `id:` would be a model, not a provider.
  if (file.endsWith("/index.ts")) {
    return (
      source.match(
        /[A-Za-z_$][\w$]*Provider(?:\s*:\s*RegistryEntry)?\s*=\s*(?:[A-Za-z_$][\w$]*\s*\(\s*)?\{\s*id:\s*["']([^"']+)["']/
      )?.[1] ?? null
    );
  }
  return source.match(/\bid:\s*["']([^"']+)["']/)?.[1] ?? null;
}

export function compatibilityAliasMap(source, file, localProviders) {
  const body = source.match(
    /export const PROVIDER_COMPATIBILITY_ALIASES = \{([\s\S]*?)\}\s+as const;/
  )?.[1];
  if (!body) throw new Error(`Could not read compatibility aliases from ${file}`);
  const aliases = new Map();
  const entries = /^\s*(?:"([^"]+)"|([A-Za-z][A-Za-z0-9_-]*)):\s*"([^"]+)"\s*,?\s*$/gm;
  for (const match of body.matchAll(entries)) {
    const alias = match[1] || match[2];
    const id = match[3];
    if (!localProviders.has(id)) {
      throw new Error(`Compatibility alias ${alias} points to missing provider ${id}`);
    }
    aliases.set(alias, { id, file });
  }
  return aliases;
}
