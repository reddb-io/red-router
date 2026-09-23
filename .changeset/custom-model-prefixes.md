---
"@reddb-io/red-router": minor
---

Give models your own prefixes and names. Each connection of a built-in provider has a "Model prefix" field (Edit connection): `codex-work/<model>` and `codex-home/<model>` then route to their own Codex account only, with no fallback to the other one, while `codex/<model>` keeps using every account. A prefix is lowercase (`[a-z0-9][a-z0-9._-]*`, at most 64 characters) and may not be a built-in provider token, another provider's connection prefix, a custom node prefix or a combo name; connections of the same provider may share one to form a pool. A prefix set on a built-in connection used to be listed by `/v1/models` without routing; it now routes.

`/v1/models` lists a provider's models once per connection prefix, and under the default prefix only while some account has none. An entry under a prefix one account carries names it in `provider.connection: { id, name }`; `aliases` hold the slug and legacy forms only when they reach the same accounts. `catalog.prefixStyle` still applies to default prefixes, and `/v1/catalog` groups each prefix separately (`provider.model_prefix`, `provider.connection`).

User model aliases are listed as models of their own: `{ id: "<alias>", owned_by: "alias", name, alias_of: "<target id>", provider, capabilities, context_length, max_completion_tokens, thinking_levels, parameters }`, taken from the target, and `GET /v1/models/<alias>` returns that entry. An alias is listed only while its target is in the caller's catalog, and a combo of the same name takes precedence. Aliases also resolve through custom node and connection prefixes. `/v1/catalog` returns them under `aliases`.

The provider page gains a "Name & alias" action on each model: a display name that `/v1/models` shows instead of the catalog name, and an alias with its own display name that can route through a connection prefix. `GET /v1/capabilities` advertises `catalog.custom_prefixes` and `catalog.model_aliases_listed`.
