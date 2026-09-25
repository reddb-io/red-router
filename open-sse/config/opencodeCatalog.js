import { FORMATS } from "../translator/formats.js";

// Live OpenCode model lists. Both are public OpenAI-style /models endpoints; the
// Go list says which Go models exist today, the Zen list which JEV models Zen serves.
export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
export const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";

export const OPENCODE_CATALOG_TTL_MS = 60 * 60 * 1000;
// After a failed fetch, keep serving the last good (or built-in) list this long
// before trying the network again, instead of paying a timeout on every call.
export const OPENCODE_CATALOG_RETRY_MS = 5 * 60 * 1000;
export const OPENCODE_CATALOG_TIMEOUT_MS = 5000;

// Upstream ids of the System One evaluator family in the Zen list.
export const OPENCODE_SYSTEM_ONE_ID_RE = /^jev-[A-Za-z0-9][A-Za-z0-9._-]*$/;

// models.dev names the SDK a model is served through (`provider.npm`); for OpenCode
// that is the endpoint. Models on @ai-sdk/openai live on /responses only; models on
// @ai-sdk/anthropic also answer /chat/completions, like the built-in MiniMax and
// Qwen entries. Anything else is a /chat/completions model.
export const OPENCODE_NPM_FORMATS = {
  "@ai-sdk/openai": { targetFormat: FORMATS.OPENAI_RESPONSES, supportedFormats: [FORMATS.OPENAI_RESPONSES] },
  "@ai-sdk/anthropic": { supportedFormats: [FORMATS.OPENAI, FORMATS.CLAUDE] },
};
export const OPENCODE_DEFAULT_FORMATS = { supportedFormats: [FORMATS.OPENAI] };
