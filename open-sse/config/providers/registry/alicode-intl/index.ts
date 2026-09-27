import type { RegistryEntry } from "../../shared.ts";

/** International Coding Plan keys are not interchangeable with Model Studio keys. */
export const alicode_intlProvider: RegistryEntry = {
  id: "alicode-intl",
  alias: "alicode-intl",
  format: "openai",
  executor: "default",
  baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: [
    { id: "qwen3.5-plus", name: "Qwen3.5 Plus" },
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "glm-5", name: "GLM 5" },
    { id: "MiniMax-M2.5", name: "MiniMax M2.5" },
    { id: "qwen3-coder-next", name: "Qwen3 Coder Next" },
    { id: "qwen3-coder-plus", name: "Qwen3 Coder Plus" },
    { id: "glm-4.7", name: "GLM 4.7" },
  ],
};
