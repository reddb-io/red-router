import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

import {
  handleLegacyMcpBody,
  LEGACY_MCP_SCHEMA_VERSION,
  MAX_LEGACY_MCP_BODY_BYTES,
  type LegacyMcpTool,
} from "./legacyProtocol";

export interface LegacyMcpHttpKey {
  id: string;
  isAdmin: boolean;
}

export interface LegacyMcpHttpDependencies {
  authenticate(token: string): Promise<LegacyMcpHttpKey | null>;
  tools(): readonly LegacyMcpTool[];
  appVersion: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const RESPONSE_HEADERS = {
  "x-redrouter-mcp-version": String(LEGACY_MCP_SCHEMA_VERSION),
  "cache-control": "no-store",
};

function rpcError(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {}
) {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code, message: sanitizeErrorMessage(message) } },
    { status, headers: { ...RESPONSE_HEADERS, ...headers } }
  );
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return LOOPBACK_HOSTS.has(url.hostname) || url.host === request.headers.get("host");
  } catch {
    return false;
  }
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

async function readBoundedBody(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_LEGACY_MCP_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

/** Stateless legacy JSON-RPC transport. Authentication is mandatory even when /v1 is open. */
export async function handleLegacyMcpHttpRequest(
  request: Request,
  dependencies: LegacyMcpHttpDependencies
): Promise<Response> {
  if (!originAllowed(request)) return rpcError(403, -32600, "Origin not allowed");
  const token = bearerToken(request);
  if (!token) {
    return rpcError(401, -32001, "Missing API key: send Authorization: Bearer <API key>", {
      "WWW-Authenticate": 'Bearer realm="red-router", error="invalid_token"',
    });
  }

  let key: LegacyMcpHttpKey | null;
  try {
    key = await dependencies.authenticate(token);
  } catch {
    return rpcError(503, -32000, "Authentication temporarily unavailable");
  }
  if (!key) {
    return rpcError(401, -32001, "Invalid API key", {
      "WWW-Authenticate": 'Bearer realm="red-router", error="invalid_token"',
    });
  }

  let raw: string | null;
  try {
    raw = await readBoundedBody(request);
  } catch {
    return rpcError(400, -32600, "Invalid Request");
  }
  if (raw === null) return rpcError(413, -32600, "Request body too large");

  try {
    const result = await handleLegacyMcpBody(raw, {
      info: { name: "red-router", title: "RedRouter", version: dependencies.appVersion },
      instructions:
        "These tools describe models visible to this API key. Confirm with the user before changing a key or routing choice.",
      context: { apiKeyId: key.id, isAdmin: key.isAdmin, apiKeyToken: token },
      tools: dependencies.tools(),
    });
    if (result === null) return new Response(null, { status: 202, headers: RESPONSE_HEADERS });
    return Response.json(result, { headers: RESPONSE_HEADERS });
  } catch {
    return rpcError(500, -32603, "Legacy MCP request failed");
  }
}
