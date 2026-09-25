---
"@reddb-io/red-router": minor
---

**MCP: quotas, API keys and usage per key. The MCP always requires a key.**

- **API key required.** Every call to `/v1/mcp` now needs a valid RedRouter API key (`Authorization: Bearer <key>`), even when "Require API key" is off for `/v1`. A missing or invalid key gets 401 with `WWW-Authenticate: Bearer`.
- **`get_quotas`:** provider quota windows (used, total, remaining, reset time) for the accounts the key can route to. It reads the last report RedRouter holds; `refresh: true` asks the providers now.
- **`get_api_key`:** the calling key's settings (name, tags, limits, model rules, id format). The secret is never returned.
- **Key management**, allowed only for a key with **"Manage API keys via MCP"** turned on (Endpoint & Keys → the key; off by default):
  - `list_api_keys` lists keys with this month's spend each.
  - `get_usage` with `api_key_id` reads another key's usage.
  - `create_api_key` creates a key with a name and optional tags, limits and id format. A key created this way never gets the manage permission.
  - While resource scoping is on, a manager key only reaches the keys its owner can see.
