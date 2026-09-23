---
"@reddb-io/red-router": minor
---

`/v1/models` lists readable ids: `<slug>/<model>` (for example `claude-code/claude-opus-5`, `copilot/gpt-4o`, `codex/gpt-5.5`) instead of the short codes (`cc/`, `gh/`, `cx/`). Every entry now carries `name` (the model's display name), `provider` (`id`, `slug`, legacy `prefix`, display `name`, `category`, `subscription`) and `aliases` (the legacy id, for example `cc/claude-opus-5`, so clients can migrate saved ids); `owned_by` is the slug. Combos add `name` and `provider: { id: "combo", name: "Combo" }`; models from a remote RedRouter keep the remote's `name` and `provider` and add `via: "red-router"`. `/v1/models/{id}` also finds an entry by a legacy id.

Every provider token routes: slug, id, alias, extra aliases and the dashboard badge code. Legacy short codes keep working forever. This fixes `pa/` (Perplexity Agent) and `voyage/` (Voyage AI), which were listed but fell through to the OpenAI upstream, and `mmf/`, which a hidden duplicate provider shadowed so it never reached MiMo Free. Built-in tokens, slugs included, take precedence over a custom node prefix that uses the same name.

Clients that must keep the old ids can set `catalog.prefixStyle: "short"` (`PATCH /api/settings`); `GET /v1/capabilities` reports the active style under `catalog.prefix_style`.
