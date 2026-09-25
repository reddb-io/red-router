---
"@reddb-io/red-router": minor
---

**RedRouter MCP server at `/v1/mcp`.** Agents can now ask RedRouter what their API key can use. The server is read-only, uses MCP over HTTP, and is authenticated with the same API key as `/v1`.

Tools:
- `list_models`: models and combos, with context size, capabilities, thinking levels and price per 1M tokens.
- `get_model`: one model or combo, including a combo's members in the order they are tried.
- `list_combos`: the routing combos.
- `list_providers`: accounts by status (ok, rate limited, error, disabled) and recent health, with no account details.
- `recommend_models`: a ranking by required capabilities, context and price. Pass `current` to get the price and context difference against it and the reasons (for example, the current model is rate limited or a cheaper one exists), or `equivalent_to` to find cheaper or healthier models with the same capabilities.
- `get_usage`: this key's requests, tokens and cost per model, its limits and this month's spend.

Nothing in it changes routing. An agent can suggest another model or combo, and switches only when its user agrees.

To connect Claude Code: `claude mcp add --transport http red-router http://localhost:25050/v1/mcp --header "Authorization: Bearer <API key>"`. The MCP URL is also shown on Endpoint & Keys.
