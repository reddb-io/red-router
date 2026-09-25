// An API key's role. "standard" keys (the default) call models; an "admin" key
// also gets RedRouter's admin MCP tools: list, inspect and create API keys within
// its owner's scope. Clients learn the role from /v1/key or the
// x-redrouter-key-role header on /v1/models, and register /v1/mcp with the same key.
export const KEY_ROLES = ["standard", "admin"];

export function normalizeKeyRole(value) {
  return value === "admin" ? "admin" : "standard";
}
