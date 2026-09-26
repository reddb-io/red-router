import type { RegistryEntry } from "../../shared.ts";

/** Token Plan keys use the Singapore OpenAI-compatible surface. */
export const alitp_intlProvider: RegistryEntry = {
  id: "alitp-intl",
  alias: "alitp-intl",
  format: "openai",
  executor: "default",
  baseUrl:
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: [
    { id: "qwen3.8-max-preview", name: "Qwen3.8 Max Preview" },
    { id: "qwen3.7-max", name: "Qwen3.7 Max" },
    { id: "qwen3.7-plus", name: "Qwen3.7 Plus" },
    { id: "qwen3.6-flash", name: "Qwen3.6 Flash" },
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  ],
};
