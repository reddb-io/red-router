// A minimal Model Context Protocol server over JSON-RPC: initialize, ping,
// tools/list and tools/call, stateless (no session, no server-initiated
// messages). The HTTP route (src/app/api/v1/mcp/route.js) answers each POST with
// one JSON body, the "application/json" form of Streamable HTTP.
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const JSONRPC = "2.0";
const ERRORS = {
  parse: { code: -32700, message: "Parse error" },
  invalidRequest: { code: -32600, message: "Invalid Request" },
  methodNotFound: { code: -32601, message: "Method not found" },
  invalidParams: { code: -32602, message: "Invalid params" },
  internal: { code: -32603, message: "Internal error" },
};

const reply = (id, result) => ({ jsonrpc: JSONRPC, id, result });
const fail = (id, error, data) => ({ jsonrpc: JSONRPC, id: id ?? null, error: { ...error, ...(data ? { data } : {}) } });

/** Only the keys the tool's input schema declares, with its required ones present. */
function checkArguments(tool, args) {
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) return "arguments must be an object";
  const input = args || {};
  for (const name of tool.inputSchema?.required || []) {
    if (input[name] === undefined) return `missing required argument "${name}"`;
  }
  const known = Object.keys(tool.inputSchema?.properties || {});
  const unknown = Object.keys(input).filter((k) => !known.includes(k));
  return unknown.length ? `unknown argument(s): ${unknown.join(", ")}` : null;
}

/**
 * Handle one JSON-RPC message. Returns the response, or null for a notification.
 * @param {object} message
 * @param {{ info: {name:string,title?:string,version:string}, instructions?: string, tools: object[], context: object }} server
 */
export async function handleMcpMessage(message, server) {
  if (!message || typeof message !== "object" || message.jsonrpc !== JSONRPC || typeof message.method !== "string") {
    return fail(message?.id, ERRORS.invalidRequest);
  }
  const { id, method, params = {} } = message;
  const isNotification = id === undefined;
  if (isNotification) return null; // notifications/initialized, notifications/cancelled: nothing to do

  try {
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return reply(id, {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: server.info,
          ...(server.instructions ? { instructions: server.instructions } : {}),
        });
      }
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, {
          tools: server.tools.map(({ name, title, description, inputSchema, annotations }) => ({
            name, ...(title ? { title } : {}), description, inputSchema, ...(annotations ? { annotations } : {}),
          })),
        });
      case "tools/call": {
        const tool = server.tools.find((t) => t.name === params?.name);
        if (!tool) return fail(id, ERRORS.invalidParams, `Unknown tool "${params?.name}"`);
        const problem = checkArguments(tool, params.arguments);
        if (problem) return fail(id, ERRORS.invalidParams, problem);
        try {
          const result = await tool.run(params.arguments || {}, server.context);
          return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result });
        } catch (error) {
          // A tool failure is a result the model can read, not a protocol error.
          return reply(id, { content: [{ type: "text", text: error?.message || String(error) }], isError: true });
        }
      }
      default:
        return fail(id, ERRORS.methodNotFound, method);
    }
  } catch (error) {
    return fail(id, ERRORS.internal, error?.message);
  }
}

/** A POST body: one message or a batch. Returns the body to send, or null (202, nothing to say). */
export async function handleMcpBody(raw, server) {
  let body;
  try {
    body = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return fail(null, ERRORS.parse);
  }
  if (Array.isArray(body)) {
    if (!body.length) return fail(null, ERRORS.invalidRequest);
    const out = (await Promise.all(body.map((m) => handleMcpMessage(m, server)))).filter(Boolean);
    return out.length ? out : null;
  }
  return handleMcpMessage(body, server);
}
