/**
 * Historical 9router / RedRouter v0.33.0 provider ids and short aliases that name an existing
 * OmniRoute connection product. Saved models (`vx/gemini-2.5`), combos and client configs keep
 * routing through them. Only aliases this build does not already own are listed: an alias the
 * registry defines (for example `if`, `kmc`) keeps this build's meaning.
 */
export const PROVIDER_COMPATIBILITY_ALIASES = {
  commandcode: "command-code",
  cmc: "command-code",
  "volcengine-ark": "volcengine-coding-plan",
  ark: "volcengine-coding-plan",
  "xiaomi-tokenplan": "xiaomi-mimo-token-plan",
  xmtp: "xiaomi-mimo-token-plan",
  ocg: "opencode-go",
  qd: "qoder",
  vercel: "vercel-ai-gateway",
  ch: "chutes",
  vx: "vertex",
  vxp: "vertex-partner",
  gcli: "grok-cli",
  gb: "grok-cli",
  "grok-build": "grok-cli",
  pw: "perplexity-web",
  airforce: "api-airforce",
  "llm-7": "llm7",
  kgw: "kilo-gateway",
  hunyuan: "tencent",
  qianfan: "baidu",
  ernie: "baidu",
  morphllm: "morph",
  typesafe: "typesafe-ai",
} as const;

export function resolveProviderCompatibilityAlias(provider: string): string {
  return (
    PROVIDER_COMPATIBILITY_ALIASES[provider as keyof typeof PROVIDER_COMPATIBILITY_ALIASES] ??
    provider
  );
}
