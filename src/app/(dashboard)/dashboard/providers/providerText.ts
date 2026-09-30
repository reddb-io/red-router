export type ProviderMessageTranslator = ((
  key: string,
  values?: Record<string, unknown>
) => string) & {
  has?: (key: string) => boolean;
};

/**
 * Translated copy when the key exists, otherwise the English fallback. The dashboard is
 * English-only, so the fallback is the source of truth for copy that has no message key yet.
 */
export function providerText(
  t: ProviderMessageTranslator,
  key: string,
  fallback: string,
  values?: Record<string, unknown>
): string {
  if (typeof t.has === "function" && t.has(key)) return t(key, values);
  if (!values) return fallback;
  return Object.entries(values).reduce(
    (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
    fallback
  );
}
