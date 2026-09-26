import type { RegistryEntry } from "../../shared.ts";

/**
 * CodeBuddy international (codebuddy.ai) — mirrors the codebuddy-cn registry
 * shape, swapping the Tencent CN domain for the .ai endpoint set. All
 * OAuth/plugin URLs use the /v2/plugin prefix with platform=ide (CN uses
 * platform=CLI). The alias "cbai" was reserved by codebuddy-cn for this entry.
 *
 * Ported from the legacy fork (open-sse/providers/registry/codebuddy-intl.js
 * @ c66f917c). Streaming is forced by the executor (non-stream requests are
 * rejected with code 11101).
 *
 * The device flow uses the separate .ai host and IDE platform identity.
 * See src/lib/oauth/providers/codebuddy-intl.ts for login and polling.
 */
export const codebuddy_intlProvider: RegistryEntry = {
  id: "codebuddy-intl",
  alias: "cbai",
  format: "openai",
  executor: "codebuddy-intl",
  baseUrl: "https://www.codebuddy.ai/v2/chat/completions",
  forceStream: true,
  authType: "oauth",
  authHeader: "bearer",
  headers: {
    "User-Agent": "IDE/2.108.1 CodeBuddy/2.108.1",
    "X-Product": "SaaS",
    "X-IDE-Type": "IDE",
    "X-IDE-Name": "IDE",
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
  },
  oauth: {
    tokenUrl: "https://www.codebuddy.ai/v2/plugin/auth/token",
    refreshUrl: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
  },
  models: [
    // Same model lineup exposed by the CN gateway — intl backend is the same catalog.
    { id: "glm-5.2", name: "GLM-5.2", supportsReasoning: true },
    { id: "glm-5.1", name: "GLM-5.1", supportsReasoning: true },
    { id: "glm-5.0", name: "GLM-5.0", supportsReasoning: true },
    { id: "glm-5.0-turbo", name: "GLM-5.0-Turbo", supportsReasoning: true },
    { id: "glm-5v-turbo", name: "GLM-5v-Turbo", supportsReasoning: true, supportsVision: true },
    { id: "glm-4.7", name: "GLM-4.7", supportsReasoning: true },
    { id: "minimax-m3", name: "MiniMax-M3", supportsReasoning: true, supportsVision: true },
    { id: "minimax-m2.7", name: "MiniMax-M2.7", supportsReasoning: true },
    { id: "kimi-k2.7", name: "Kimi-K2.7-Code", supportsReasoning: true },
    { id: "kimi-k2.6", name: "Kimi-K2.6", supportsReasoning: true },
    { id: "kimi-k2.5", name: "Kimi-K2.5", supportsReasoning: true },
    { id: "hy3-preview", name: "Hy3 Preview", supportsReasoning: true, supportsVision: true },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", supportsReasoning: true },
    // deepseek-v4-flash replaced server-side by deepseek-v4.1-flash (same
    // catalog as CN; the old endpoint still answers 200 but the list is the contract).
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", supportsReasoning: true },
    { id: "deepseek-v3-2-volc", name: "DeepSeek-V3.2", supportsReasoning: true },
  ],
};

export default codebuddy_intlProvider;
