import type { RegistryEntry } from "../../shared.ts";

// Discovery hints only. The executor requires each account's authenticated
// /model/list response and its exact model_config before dispatching chat.
const MODELS = [
  ["ultimate", "Ultimate"],
  ["auto", "Auto"],
  ["performance", "Performance"],
  ["efficient", "Efficient"],
  ["lite", "Lite"],
  ["qmodel_38max", "Qwen3.8-Max"],
  ["qmodel_latest", "Qwen3.7-Max"],
  ["qmodel", "Qwen3.7-Plus"],
  ["qfmodel", "Qwen3.8-Flash"],
  ["kmodel_latest", "Kimi-K3"],
  ["kmodel", "Kimi-K2.7-Code"],
  ["gmodel", "GLM-5.3"],
  ["gfmodel", "GLM-5.3-Flash"],
  ["dmodel", "DeepSeek-V4-Pro"],
  ["dfmodel", "DeepSeek-V4-Flash"],
  ["mmodel", "MiniMax-M3"],
] as const;

export const qoderCnProvider: RegistryEntry = {
  id: "qoder-cn",
  alias: "qdcn",
  format: "openai",
  executor: "qoder-cn",
  baseUrl: "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation",
  authType: "apikey",
  authHeader: "Authorization",
  authPrefix: "Bearer ",
  timeoutMs: 120_000,
  models: MODELS.map(([id, name]) => ({ id, name })),
};
