/** Historical 9router provider IDs that name an existing OmniRoute connection product. */
export const PROVIDER_COMPATIBILITY_ALIASES = {
  commandcode: "command-code",
  cmc: "command-code",
  "volcengine-ark": "volcengine-coding-plan",
  ark: "volcengine-coding-plan",
  "xiaomi-tokenplan": "xiaomi-mimo-token-plan",
  xmtp: "xiaomi-mimo-token-plan",
} as const;

export function resolveProviderCompatibilityAlias(provider: string): string {
  return (
    PROVIDER_COMPATIBILITY_ALIASES[provider as keyof typeof PROVIDER_COMPATIBILITY_ALIASES] ??
    provider
  );
}
