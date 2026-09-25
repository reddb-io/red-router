---
"@reddb-io/red-router": minor
---

**Admin API keys and MCP for quotas, keys and usage per key. The MCP always requires a key.**

- **Admin keys.** An API key is now "standard" (the default) or "admin". Turn on "Admin key" in Endpoint & Keys → the key; the keys list marks it.
  - A client using an admin key gets RedRouter's admin MCP tools: `list_api_keys` (with this month's spend each), `get_usage` for another key (`api_key_id`), and `create_api_key`, which always creates a standard key.
  - While resource scoping is on, an admin key only reaches the keys its owner can see.
- **Clients discover the role.** `GET /v1/key` returns the calling key's id, name, role and where to register the MCP server (`mcp.url`, the same key). `/v1/models` also sends `x-redrouter-key-role` and `x-redrouter-mcp` headers, so a client setting RedRouter up as a provider (redcode) learns both with no extra call.
- **API key required.** Every call to `/v1/mcp` now needs a valid RedRouter API key (`Authorization: Bearer <key>`), even when "Require API key" is off for `/v1`. A missing or invalid key gets 401 with `WWW-Authenticate: Bearer`. A standard key doesn't see the admin tools at all.
- **New tools for every key:**
  - `get_quotas`: provider quota windows (used, total, remaining, reset time) for the accounts the key can route to. It reads the last report RedRouter holds; `refresh: true` asks the providers now.
  - `get_api_key`: the calling key's settings and role. The secret is never returned.
