export const SYSTEM_ONE_PROVIDER_ID = "typesafe-ai";

export const SYSTEM_ONE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const SYSTEM_ONE_MODELS_ENDPOINT = "https://api.typesafe.ai/v1/models";
export const SYSTEM_ONE_DEFAULT_MODEL = "jev-latest";

export const SYSTEM_ONE_MODELS = [
  { id: "jev-latest", name: "JEV Latest", kind: "systemOne" },
  { id: "jev-preview", name: "JEV Preview", kind: "systemOne" },
  { id: "jev-1.13.0", name: "JEV 1.13.0", kind: "systemOne" },
];

export const SYSTEM_ONE_MODEL_PREFIXES = ["jev/", "typesafe/", "typesafe-ai/"];
