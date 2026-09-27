import packageJson from "../../../../../package.json";

import { getApiKeyMetadata, validateApiKey } from "@/lib/db/apiKeys";
import { handleLegacyMcpHttpRequest } from "@/lib/mcp/legacyHttp";
import { createLegacyTools } from "@/lib/mcp/legacyTools";
import { SYNTHETIC_ENV_API_KEY_ID } from "@/shared/constants/apiKeyIdentities";
import { hasManageScope } from "@/shared/constants/managementScopes";
import { LEGACY_MCP_SCHEMA_VERSION } from "@/lib/mcp/legacyProtocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VERSION_HEADERS = { "x-redrouter-mcp-version": String(LEGACY_MCP_SCHEMA_VERSION) };

/** Key-scoped legacy Streamable HTTP JSON-RPC transport, restricted to loopback. */
export async function POST(request: Request): Promise<Response> {
  return handleLegacyMcpHttpRequest(request, {
    appVersion: packageJson.version,
    tools: createLegacyTools,
    authenticate: async (token) => {
      const key = await getApiKeyMetadata(token);
      // The legacy contract is scoped to a persisted key. The deployment env
      // key has no per-key DB row for get_api_key/usage and must not be treated
      // as a tenant here merely because it has synthetic management metadata.
      if (!key || key.id === SYNTHETIC_ENV_API_KEY_ID || !(await validateApiKey(token))) {
        return null;
      }
      return { id: key.id, isAdmin: hasManageScope(key.scopes), machineId: key.machineId };
    },
  });
}

function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { ...VERSION_HEADERS, Allow: "POST" } });
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
