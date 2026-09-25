---
"@reddb-io/red-router": minor
---

**Flat model ids.** An API key can now get one `/v1/models` entry per model instead of one per provider offer. For example, `anthropic/claude-sonnet-4-5` covers both Anthropic direct and OpenRouter, where before there were `anthropic/claude-sonnet-4-5` and `openrouter/anthropic/claude-sonnet-4.5`. Turn it on per key in Endpoint & Keys → the key → "Model ids in /v1/models". The default is unchanged.

- **How it routes.** A flat id works like a fallback combo over the offers the key may use: cheapest first, then the fewest RedRouter hops, then the vendor's own offer. The next offer is tried when one fails.
- **Stable and safe grouping.**
  - Different versions, and free vs paid offers, are never grouped (`typesafe/jev-1.13` and `typesafe/jev-1.13:free` are separate entries).
  - A flat id doesn't change when you connect or drop a provider.
  - Requests accept either spelling (`claude-sonnet-4.5` or `-4-5`).
- **Full information for clients.** Each flat entry lists its offers with provider, RedRouter hops, price and a `pin_id` to pin one offer. `/v1/models`, `/v1/models/systemone` and `/v1/catalog` now say `id_format` at the top, and `X-RedRouter-Served-Model` still names the exact offer that answered.
