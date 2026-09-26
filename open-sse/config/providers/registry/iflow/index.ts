import { resolvePublicCred, type RegistryEntry } from "../../shared.ts";

/**
 * iFlow AI (iflow.cn) — OpenAI-compatible gateway with an HMAC-signed
 * transport (see open-sse/executors/iflow.ts).
 *
 * Ported from the legacy fork (open-sse/providers/registry/iflow.js @
 * c66f917c). Qwen/Kimi/DeepSeek/GLM catalog; OAuth is the official iFlow CLI
 * phone-login flow (public client credentials embedded via resolvePublicCred
 * per Hard Rule #11). A plain API key also works — the executor signs with
 * whichever credential the connection carries.
 *
 * TODO(fork-port): the legacy OAuth flow (authorizeUrl + `loginMethod=phone`
 * extra params + userInfo endpoint) needs a src/lib/oauth/providers/iflow.ts
 * implementation before the dashboard "Sign in" button works; until then
 * connections can be created with an API key / pasted access token.
 */
export const iflowProvider: RegistryEntry = {
  id: "iflow",
  // NOTE: the legacy fork's short alias "if" now belongs to Qoder in this
  // base (src/shared/constants/providers/oauth.ts), so iFlow resolves by its
  // full id only.
  alias: "iflow",
  format: "openai",
  executor: "iflow",
  baseUrl: "https://apis.iflow.cn/v1/chat/completions",
  authType: "oauth",
  authHeader: "bearer",
  headers: {
    "User-Agent": "iFlow-Cli",
  },
  oauth: {
    clientIdDefault: resolvePublicCred("iflow_id"),
    clientSecretDefault: resolvePublicCred("iflow_secret"),
    authUrl: "https://iflow.cn/oauth",
    tokenUrl: "https://iflow.cn/oauth/token",
  },
  models: [
    { id: "qwen3-coder-plus", name: "Qwen3 Coder Plus" },
    { id: "qwen3-max", name: "Qwen3 Max" },
    { id: "qwen3-vl-plus", name: "Qwen3 VL Plus", supportsVision: true },
    { id: "qwen3-max-preview", name: "Qwen3 Max Preview" },
    { id: "qwen3-235b", name: "Qwen3 235B A22B" },
    { id: "qwen3-235b-a22b-instruct", name: "Qwen3 235B A22B Instruct" },
    {
      id: "qwen3-235b-a22b-thinking-2507",
      name: "Qwen3 235B A22B Thinking",
      supportsReasoning: true,
    },
    { id: "qwen3-32b", name: "Qwen3 32B" },
    { id: "kimi-k2", name: "Kimi K2" },
    { id: "deepseek-v3.2", name: "DeepSeek V3.2 Exp" },
    { id: "deepseek-v3.1", name: "DeepSeek V3.1 Terminus" },
    { id: "deepseek-v3", name: "DeepSeek V3 671B" },
    { id: "deepseek-r1", name: "DeepSeek R1", supportsReasoning: true },
    { id: "glm-4.7", name: "GLM 4.7", supportsReasoning: true },
    { id: "iflow-rome-30ba3b", name: "iFlow ROME" },
  ],
};

export default iflowProvider;
