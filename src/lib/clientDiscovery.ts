import { after } from "next/server";

import { getApiKeyMetadata, validateApiKey } from "@/lib/db/apiKeys";
import { getApiKeyModelIdFormat } from "@/lib/db/apiKeys/idFormat";
import { LEGACY_MCP_SCHEMA_VERSION } from "@/lib/mcp/legacyProtocol";
import { SYNTHETIC_ENV_API_KEY_ID } from "@/shared/constants/apiKeyIdentities";
import { hasManageScope } from "@/shared/constants/managementScopes";
import { ROUTING_STRATEGY_VALUES } from "@/shared/constants/routingStrategies";
import { DECISION_HEADER, HINT_HEADER, HINT_KEYS } from "@omniroute/open-sse/decision/clientHint";
import type { DiscoveryDependencies } from "@omniroute/open-sse/handlers/clientDiscovery";

import packageJson from "../../package.json";

export const clientDiscoveryDependencies: DiscoveryDependencies = {
  async authenticate(token) {
    if (!(await validateApiKey(token))) return null;
    const key = await getApiKeyMetadata(token);
    if (!key) return null;
    const persisted = key.id !== SYNTHETIC_ENV_API_KEY_ID;
    return {
      id: key.id,
      name: key.name,
      role: hasManageScope(key.scopes) ? "admin" : "standard",
      idFormat: persisted ? getApiKeyModelIdFormat(key.id) : "prefixed",
      persisted,
    };
  },
  async catalog(request) {
    // Key identity discovery must not build or refresh the model catalog.
    const { getUnifiedModelsResponse } = await import("@/app/api/v1/models/catalog");
    return getUnifiedModelsResponse(
      request,
      {},
      {
        scheduleBackgroundRefresh: (task) => after(task),
      }
    );
  },
  version: packageJson.version,
  mcpSchemaVersion: LEGACY_MCP_SCHEMA_VERSION,
  strategies: ROUTING_STRATEGY_VALUES,
  decision: { header: DECISION_HEADER, hintHeader: HINT_HEADER, hintKeys: HINT_KEYS },
};
