import {
  SYSTEM_ONE_DEFAULT_MODEL,
  SYSTEM_ONE_MODEL_MAP,
  SYSTEM_ONE_ENDPOINT,
  SYSTEM_ONE_MODELS,
  SYSTEM_ONE_MODELS_ENDPOINT,
  SYSTEM_ONE_PROVIDER_ID,
} from "../../config/systemOne.js";

const typesafeAi = {
  id: SYSTEM_ONE_PROVIDER_ID,
  alias: SYSTEM_ONE_PROVIDER_ID,
  aliases: ["jev", "typesafe"],
  uiAlias: "jev",
  display: {
    name: "TypeSafe AI (JEV)",
    icon: "rule",
    color: "#7C3AED",
    textIcon: "JEV",
    website: "https://typesafe.ai",
    notice: {
      apiKeyUrl: "https://platform.typesafe.ai",
      text: "JEV uses its native System One contract at POST /v1/systemone (state + questions).",
    },
  },
  category: "apikey",
  authType: "apikey",
  mediaPriority: 1,
  models: SYSTEM_ONE_MODELS,
  serviceKinds: ["systemone"],
  systemOneConfig: {
    baseUrl: SYSTEM_ONE_ENDPOINT,
    validateUrl: SYSTEM_ONE_MODELS_ENDPOINT,
    defaultModel: SYSTEM_ONE_DEFAULT_MODEL,
    modelMap: SYSTEM_ONE_MODEL_MAP,
    passthroughModels: true,
    contextWindow: 64000,
    maxStateAndQuestionTokens: 32000,
  },
};

export default typesafeAi;
