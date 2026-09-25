// RedRouter MCP endpoint (Streamable HTTP, JSON responses): /v1/mcp.
//   claude mcp add --transport http red-router http://localhost:25050/v1/mcp \
//     --header "Authorization: Bearer <RedRouter API key>"
// Every call needs a valid RedRouter API key, whatever "Require API key" says for
// /v1: the key scopes each tool to what it can call, and only an admin key
// (role "admin") gets the key-management tools.
import { extractApiKey } from "@/sse/services/auth.js";
import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { getAppVersion } from "@/lib/db/version.js";
import { handleMcpBody } from "@/lib/mcp/server.js";
import { toolsForKey, RED_ROUTER_MCP_INSTRUCTIONS, MCP_SCHEMA_VERSION } from "@/lib/mcp/redRouterTools.js";

// Clients feature-detect result shapes by this, not by the app version.
const VERSION_HEADERS = { "x-redrouter-mcp-version": String(MCP_SCHEMA_VERSION) };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Browsers send Origin; a page on another site must not reach this endpoint
// through the user's browser (DNS rebinding). Clients outside a browser send none.
function originAllowed(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const { hostname, host } = new URL(origin);
    return LOOPBACK.has(hostname) || host === request.headers.get("host");
  } catch {
    return false;
  }
}

const jsonRpcError = (status, code, message, headers = {}) => Response.json(
  { jsonrpc: "2.0", id: null, error: { code, message } },
  { status, headers: { ...VERSION_HEADERS, ...headers } },
);

export async function POST(request) {
  if (!originAllowed(request)) return jsonRpcError(403, -32600, "Origin not allowed");
  const apiKey = extractApiKey(request);
  const key = apiKey ? await getApiKeyByKey(apiKey) : null;
  if (!key || key.isActive === false) {
    return jsonRpcError(401, -32001, apiKey ? "Invalid API key" : "Missing API key: send Authorization: Bearer <RedRouter API key>", {
      "WWW-Authenticate": 'Bearer realm="red-router", error="invalid_token"',
    });
  }
  const raw = await request.text();
  const out = await handleMcpBody(raw, {
    info: { name: "red-router", title: "RedRouter", version: getAppVersion() },
    instructions: RED_ROUTER_MCP_INSTRUCTIONS,
    meta: { "io.reddb/red-router-mcp-version": MCP_SCHEMA_VERSION },
    tools: toolsForKey(key),
    context: { apiKey, key },
  });
  if (out === null) return new Response(null, { status: 202, headers: VERSION_HEADERS });
  return Response.json(out, { headers: VERSION_HEADERS });
}

// No server-initiated stream and no sessions: a GET stream or DELETE is not offered.
export async function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export async function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
