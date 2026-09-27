import { z } from "zod";

import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

export const LEGACY_MCP_SCHEMA_VERSION = 4;
export const LEGACY_MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MAX_LEGACY_MCP_BODY_BYTES = 1024 * 1024;

const rpcMessageSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number().finite(), z.null()]).optional(),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .passthrough();

const toolCallSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export class LegacyMcpToolError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export interface LegacyMcpContext {
  apiKeyId: string;
  isAdmin: boolean;
  /** Persisted caller machine ID, when the admin key has one. */
  apiKeyMachineId?: string | null;
  /** Server-side bearer only; never copy it into a tool result. */
  apiKeyToken?: string;
}

export interface LegacyMcpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  argsSchema: z.ZodType;
  annotations?: Record<string, unknown>;
  admin?: boolean;
  run: (args: Record<string, unknown>, context: LegacyMcpContext) => Promise<unknown>;
}

export interface LegacyMcpServer {
  info: { name: string; title?: string; version: string };
  instructions?: string;
  context: LegacyMcpContext;
  tools: readonly LegacyMcpTool[];
}

function reply(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function fail(id: string | number | null, code: number, message: string, data?: string) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: { code, message, ...(data ? { data: sanitizeErrorMessage(data) } : {}) },
  };
}

export async function handleLegacyMcpMessage(message: unknown, server: LegacyMcpServer) {
  const parsed = rpcMessageSchema.safeParse(message);
  if (!parsed.success) return fail(null, -32600, "Invalid Request");
  const { id, method, params } = parsed.data;
  if (id === undefined) return null;

  const tools = server.tools.filter((tool) => !tool.admin || server.context.isAdmin);
  switch (method) {
    case "initialize": {
      const requested =
        params && typeof params === "object" && "protocolVersion" in params
          ? params.protocolVersion
          : undefined;
      const protocolVersion = LEGACY_MCP_PROTOCOL_VERSIONS.find((version) => version === requested);
      return reply(id, {
        protocolVersion: protocolVersion || LEGACY_MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: server.info,
        ...(server.instructions ? { instructions: server.instructions } : {}),
        _meta: { "io.reddb/red-router-mcp-version": LEGACY_MCP_SCHEMA_VERSION },
      });
    }
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
          name,
          ...(title ? { title } : {}),
          description,
          inputSchema,
          ...(annotations ? { annotations } : {}),
        })),
      });
    case "tools/call": {
      const call = toolCallSchema.safeParse(params);
      if (!call.success) return fail(id, -32602, "Invalid params");
      const tool = tools.find((candidate) => candidate.name === call.data.name);
      if (!tool) return fail(id, -32602, "Invalid params", "Unknown tool");
      const args = tool.argsSchema.safeParse(call.data.arguments || {});
      if (
        !args.success ||
        !args.data ||
        typeof args.data !== "object" ||
        Array.isArray(args.data)
      ) {
        return fail(id, -32602, "Invalid params");
      }
      try {
        const result = await tool.run(args.data as Record<string, unknown>, server.context);
        return reply(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        });
      } catch (error) {
        const known = error instanceof LegacyMcpToolError;
        const code = known && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : "internal";
        const failure = {
          code,
          message: known ? sanitizeErrorMessage(error.message) : "Legacy MCP tool failed",
        };
        return reply(id, {
          content: [{ type: "text", text: failure.message }],
          structuredContent: { error: failure },
          isError: true,
        });
      }
    }
    default:
      return fail(id, -32601, "Method not found");
  }
}

export async function handleLegacyMcpBody(raw: string, server: LegacyMcpServer) {
  if (Buffer.byteLength(raw, "utf8") > MAX_LEGACY_MCP_BODY_BYTES) {
    return fail(null, -32600, "Invalid Request", "Request body too large");
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(null, -32700, "Parse error");
  }
  if (Array.isArray(body)) {
    if (body.length === 0) return fail(null, -32600, "Invalid Request");
    const replies = await Promise.all(
      body.map((message) => handleLegacyMcpMessage(message, server))
    );
    const answered = replies.filter((response) => response !== null);
    return answered.length ? answered : null;
  }
  return handleLegacyMcpMessage(body, server);
}
