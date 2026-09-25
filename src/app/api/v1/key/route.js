// GET /v1/key: what the calling API key is, for clients setting RedRouter up as a
// provider. `role` says whether its client gets the admin MCP tools; `mcp` is
// where to register RedRouter's MCP server with the same key.
import { extractApiKey } from "@/sse/services/auth.js";
import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { MCP_SCHEMA_VERSION } from "@/lib/mcp/redRouterTools.js";

export const MCP_PATH = "/v1/mcp";

export async function GET(request) {
  const apiKey = extractApiKey(request);
  const key = apiKey ? await getApiKeyByKey(apiKey) : null;
  if (!key || key.isActive === false) {
    return Response.json(
      { error: { message: apiKey ? "Invalid API key" : "Missing API key", type: "invalid_request_error", code: "invalid_api_key" } },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="red-router"' } },
    );
  }
  return Response.json({
    object: "api_key",
    id: key.id,
    name: key.name,
    role: key.role || "standard",
    id_format: key.modelIdFormat || "prefixed",
    mcp: { url: new URL(MCP_PATH, request.url).toString(), transport: "streamable-http", schema_version: MCP_SCHEMA_VERSION, admin_tools: key.role === "admin" },
  });
}
