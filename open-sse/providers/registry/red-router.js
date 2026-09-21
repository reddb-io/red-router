export default {
  id: "red-router",
  alias: "red-router",
  priority: 1,
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  hasProviderSpecificData: true,
  display: {
    name: "RedRouter",
    icon: "router",
    color: "#E5484D",
    textIcon: "RR",
    website: "https://github.com/reddb-io/red-router",
    notice: {
      text: "Connect to another RedRouter. Accounts and provider access stay on the remote machine; this instance only needs its URL and a RedRouter API key.",
    },
  },
  transport: {
    // Runtime replaces this with providerSpecificData.baseUrl.
    baseUrl: "http://127.0.0.1:25050/v1/chat/completions",
    format: "openai",
  },
  models: [],
  passthroughModels: true,
  serviceKinds: ["llm"],
};
