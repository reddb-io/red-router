export const SYSTEM_ONE_PROVIDER_ID = "typesafe-ai";
export const SYSTEM_ONE_PROVIDER_IDS = [SYSTEM_ONE_PROVIDER_ID, "vercel-ai-gateway", "openrouter", "opencode-zen"];

export const SYSTEM_ONE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const SYSTEM_ONE_MODELS_ENDPOINT = "https://api.typesafe.ai/v1/models";
export const SYSTEM_ONE_DEFAULT_MODEL = "jev-latest";
export const SYSTEM_ONE_MODEL_MAP = {
  "jev-1.13": "jev-1.13.0",
};

export const OPENROUTER_SYSTEM_ONE_ENDPOINT = "https://openrouter.ai/api/v1/systemone";
export const OPENROUTER_SYSTEM_ONE_MODEL = "typesafe/jev-1.13";
export const OPENROUTER_SYSTEM_ONE_MODEL_MAP = {
  "jev-latest": OPENROUTER_SYSTEM_ONE_MODEL,
  "jev-1.13": OPENROUTER_SYSTEM_ONE_MODEL,
  "jev-1.13.0": OPENROUTER_SYSTEM_ONE_MODEL,
};

export const SYSTEM_ONE_MODELS = [
  { id: "jev-latest", name: "JEV Latest", kind: "systemone" },
  { id: "jev-preview", name: "JEV Preview", kind: "systemone" },
  { id: "jev-1.13.0", name: "JEV 1.13.0", kind: "systemone" },
];

export const SYSTEM_ONE_MODEL_PREFIXES = [
  "vercel-ai-gateway/",
  "vercel/",
  "openrouter/typesafe/",
  "typesafe-ai/",
  "openrouter/",
  "opencode-zen/",
  "ocz/",
  "typesafe/",
  "jev/",
];
