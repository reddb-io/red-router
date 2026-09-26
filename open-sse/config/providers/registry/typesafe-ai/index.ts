import type { RegistryEntry } from "../../shared.ts";
import { JEV_DEFAULT_BASE, JEV_DEFAULT_MODEL, JEV_ENDPOINT_PATH } from "../../../jev.ts";

/**
 * TypeSafe AI — JEV "System One" decision-model provider (typesafe.ai).
 *
 * Ported from the legacy fork (open-sse/providers/registry/typesafe-ai.js @
 * c66f917c, backed by config/systemOne.js). JEV is NOT a chat provider: it is
 * a routing classifier (unstructured state in, typed probabilities out) that
 * Auto-Combo consults before model ordering — see open-sse/decision/jev.ts.
 * It is still registered as a chat apikey entry so the operator's JEV key is
 * a first-class connection; `systemOneConfig` carries the native contract
 * URL that decisionUrlFor() resolves (resolves the TODO(fork-port) note in
 * open-sse/decision/jev.ts).
 */
export const typesafe_aiProvider: RegistryEntry = {
  id: "typesafe-ai",
  alias: "jev",
  format: "openai",
  executor: "default",
  baseUrl: `${JEV_DEFAULT_BASE}${JEV_ENDPOINT_PATH}`,
  authType: "apikey",
  authHeader: "bearer",
  defaultContextLength: 64000,
  systemOneConfig: {
    baseUrl: `${JEV_DEFAULT_BASE}${JEV_ENDPOINT_PATH}`,
    validateUrl: `${JEV_DEFAULT_BASE}/v1/models`,
    defaultModel: JEV_DEFAULT_MODEL,
    passthroughModels: true,
    contextWindow: 64000,
    maxStateAndQuestionTokens: 32000,
  },
  models: [
    { id: JEV_DEFAULT_MODEL, name: "JEV Latest" },
    { id: "jev-preview", name: "JEV Preview" },
    { id: "jev-1.13.0", name: "JEV 1.13.0" },
  ],
};

export default typesafe_aiProvider;
