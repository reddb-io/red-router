/** 9router web IDs whose transports have different canonical OmniRoute IDs. */
export const WEB_LEGACY_IDS: Readonly<Record<string, string>> = {
  "exa-search/fetch": "exa/fetch",
  "ollama-cloud/fetch": "ollama/fetch",
  "tavily-search/fetch": "tavily/fetch",
  "exa-search/search": "exa/search",
  "tavily-search/search": "tavily/search",
};

const WEB_CANONICAL_IDS = Object.fromEntries(
  Object.entries(WEB_LEGACY_IDS).map(([canonical, legacy]) => [legacy, canonical])
);

export function canonicalWebModelId(legacyId: string): string | undefined {
  return WEB_CANONICAL_IDS[legacyId];
}
