---
"@reddb-io/red-router": minor
---

- **Client beta flags are kept.** The client's `anthropic-beta` flags now reach Anthropic, merged with RedRouter's own. Before, they were replaced, so a Claude Code `[1m]` model silently lost its 1M context flag. The Claude Code identity flag is still stripped for third-party gateways.
- **Capability overrides.** You can correct a model's capabilities (images, PDFs, tools, reasoning, whether thinking can be turned off, forced tool choice, web search, context window, max output) from the new "Capabilities" button on each model of a provider page. An override wins over every built-in table and the synced catalog, and applies to routing, `/v1/models` and `parameters`.
- **Cost-class fallback policy.** A new setting, "Combo Fallback Across Plans and API Keys", decides whether a combo led by a subscription account may fall back to a pay-per-token API key. `no-metered` never falls back to one; `same-class` stays in the lead's class both ways. It can also be set per combo (`costClassFallback`). The default, `allow`, keeps today's behavior.
