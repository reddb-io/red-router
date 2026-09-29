import { getAnthropicCompatHeaders, type RegistryEntry } from "../../shared.ts";

export const deepseekProvider: RegistryEntry = {
  id: "deepseek",
  alias: "ds",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.deepseek.com/chat/completions",
  authType: "apikey",
  defaultContextLength: 1_000_000,
  authHeader: "bearer",
  alternateFormats: [
    {
      format: "openai-responses",
      baseUrl: "https://api.deepseek.com/responses",
      authHeader: "bearer",
      label: "Responses-compatible",
    },
    {
      format: "claude",
      baseUrl: "https://api.deepseek.com/anthropic/v1/messages",
      authHeader: "x-api-key",
      headers: getAnthropicCompatHeaders(),
      label: "Anthropic-compatible",
    },
  ],
  models: [
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro (0813)",
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      supportsReasoning: true,
      supportedThinkingEfforts: ["none", "low", "high", "max"],
      toolCalling: true,
    },
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash (0731)",
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      supportsReasoning: true,
      supportedThinkingEfforts: ["none", "low", "high", "max"],
      toolCalling: true,
    },
    // deepseek-v4.* accepts the full low..max effort ladder (9router 367fc546d8);
    // "none" stays in the vocabulary as the disable-thinking option. The dotted
    // V4.1 release is natively multimodal (9router 912ed295db).
    {
      id: "deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      supportsReasoning: true,
      supportsVision: true,
      supportedThinkingEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      toolCalling: true,
    },
    {
      id: "deepseek-flash",
      name: "DeepSeek V4.1 Flash",
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      supportsReasoning: true,
      supportedThinkingEfforts: ["none", "low", "high", "max"],
      toolCalling: true,
    },
  ],
};
