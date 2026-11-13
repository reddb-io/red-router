# Legacy → Rust/SPA source inventory

Generated with `node --import tsx scripts/research/legacy-rust-parity.ts`.

Baseline: `525a71de4ac25968d0a25e52eeb1b09cc21c6e92` (2026-10-16), the last first-parent main commit available on 2026-10-29. All comparisons use that immutable tree, not a contemporary upstream release.

Static inventory only. No completed-parity percentage. API method extraction is a search aid and may require manual review of wrappers/re-exports. Remapped routes are not necessarily absent features.

The prioritized behavioral backlog is [LEGACY_RUST_PARITY_BACKLOG.md](LEGACY_RUST_PARITY_BACKLOG.md). The complete API, executor, database and migration lists are in [legacy-rust-parity.json](../../config/upstream/legacy-rust-parity.json). This file is a route inventory, **not a release sign-off**.

## Source counts

```json
{
  "areas": 8,
  "navigationGroups": 33,
  "navigationSurfaces": 106,
  "spaPages": 15,
  "missingSpaRoutes": 69,
  "partialSpaRoutes": 35,
  "externalLinks": 2,
  "oldApiRouteFiles": 803,
  "rustRegisteredPaths": 88,
  "samePathCandidates": 28
}
```

## Every historical navigation surface

Partial means an existing page resolves the URL, not that the named functionality works. Prefix matches (providers, combos, audit) require particular care. External links have not been accepted as feature implementations.

| Area | Group / page | Historical URL | Current SPA target | Audit status |
| --- | --- | --- | --- | --- |
| home | analytics / Usage | `/dashboard/analytics` | usage | partial-requires-behavior-review |
| home | analytics / Topology | `/home` | overview | partial-requires-behavior-review |
| home | analytics / Combo health | `/dashboard/analytics/combo-health` | — | missing-spa-route |
| home | analytics / Utilization | `/dashboard/analytics/utilization` | — | missing-spa-route |
| home | analytics / Search | `/dashboard/analytics/search` | — | missing-spa-route |
| home | analytics / Evals | `/dashboard/analytics/evals` | — | missing-spa-route |
| home | analytics / Cache health | `/dashboard/analytics/cache-health` | — | missing-spa-route |
| home | analytics / Route trace | `/dashboard/analytics/route-trace` | — | missing-spa-route |
| home | analytics / Provider stats | `/dashboard/provider-stats` | overview | partial-requires-behavior-review |
| home | setup / Setup | `/dashboard/setup` | — | missing-spa-route |
| proxy | endpoint-keys / Endpoint | `/dashboard/endpoint` | endpoints | partial-requires-behavior-review |
| proxy | endpoint-keys / MCP | `/dashboard/mcp` | — | missing-spa-route |
| proxy | endpoint-keys / A2A | `/dashboard/a2a` | — | missing-spa-route |
| proxy | endpoint-keys / API keys | `/dashboard/api-manager` | keys | partial-requires-behavior-review |
| proxy | endpoint-keys / Key routing | `/dashboard/api-manager/routing` | keys | partial-requires-behavior-review |
| proxy | providers / Providers | `/dashboard/providers` | providers | partial-requires-behavior-review |
| proxy | providers / Free tiers | `/dashboard/free-tiers` | — | missing-spa-route |
| proxy | providers / Rankings | `/dashboard/free-provider-rankings` | — | missing-spa-route |
| proxy | providers / Radar | `/dashboard/radar` | — | missing-spa-route |
| proxy | providers / Local services | `/dashboard/providers/services` | providers | partial-requires-behavior-review |
| proxy | providers / Media providers | `/dashboard/media-providers` | — | missing-spa-route |
| proxy | providers / Relay | `/dashboard/relay` | — | missing-spa-route |
| proxy | model-catalog / Models | `/dashboard/models` | models | partial-requires-behavior-review |
| proxy | combos / Combos | `/dashboard/combos` | combos | partial-requires-behavior-review |
| proxy | combos / Live | `/dashboard/combos/live` | combos | partial-requires-behavior-review |
| proxy | combos / Test combo | `/dashboard/combos/playground` | combos | partial-requires-behavior-review |
| optimize | token-saver / Overview | `/dashboard/context/settings` | — | missing-spa-route |
| optimize | token-saver / Engines | `/dashboard/context/engines` | — | missing-spa-route |
| optimize | token-saver / Caveman | `/dashboard/context/caveman` | — | missing-spa-route |
| optimize | token-saver / RTK | `/dashboard/context/rtk` | — | missing-spa-route |
| optimize | token-saver / Headroom | `/dashboard/context/headroom` | — | missing-spa-route |
| optimize | token-saver / Session dedup | `/dashboard/context/session-dedup` | — | missing-spa-route |
| optimize | token-saver / CCR | `/dashboard/context/ccr` | — | missing-spa-route |
| optimize | token-saver / LLMLingua | `/dashboard/context/llmlingua` | — | missing-spa-route |
| optimize | token-saver / Lite | `/dashboard/context/lite` | — | missing-spa-route |
| optimize | token-saver / Aggressive | `/dashboard/context/aggressive` | — | missing-spa-route |
| optimize | token-saver / Ultra | `/dashboard/context/ultra` | — | missing-spa-route |
| optimize | token-saver / Omniglyph | `/dashboard/context/omniglyph` | — | missing-spa-route |
| optimize | token-saver / Combos | `/dashboard/context/combos` | — | missing-spa-route |
| optimize | token-saver / Studio | `/dashboard/compression/studio` | — | missing-spa-route |
| optimize | token-saver / Exclusions | `/dashboard/compression/exclusions` | — | missing-spa-route |
| optimize | token-saver / Live | `/dashboard/compression/live` | — | missing-spa-route |
| optimize | token-saver / Analytics | `/dashboard/analytics/compression` | — | missing-spa-route |
| optimize | cache / Cache | `/dashboard/cache` | — | missing-spa-route |
| optimize | cache / Media | `/dashboard/cache/media` | — | missing-spa-route |
| optimize | skills / Skills | `/dashboard/skills` | — | missing-spa-route |
| optimize | skills / Catalog | `/dashboard/agent-skills` | — | missing-spa-route |
| optimize | skills / Prompt styles | `/dashboard/skills/styles` | — | missing-spa-route |
| optimize | memory / Memory | `/dashboard/memory` | — | missing-spa-route |
| agents | agents / CLI code | `/dashboard/cli-code` | — | missing-spa-route |
| agents | agents / CLI agents | `/dashboard/cli-agents` | — | missing-spa-route |
| agents | agents / ACP | `/dashboard/acp-agents` | — | missing-spa-route |
| agents | agents / Cloud | `/dashboard/cloud-agents` | — | missing-spa-route |
| agents | conductor / Conductor | `/dashboard/conductor` | — | missing-spa-route |
| agents | conductor / Orchestration | `/dashboard/orchestration` | — | missing-spa-route |
| agents | agent-bridge / Agent bridge | `/dashboard/tools/agent-bridge` | — | missing-spa-route |
| agents | plugins / Plugins | `/dashboard/plugins` | — | missing-spa-route |
| observe | costs / Overview | `/dashboard/costs` | usage | partial-requires-behavior-review |
| observe | costs / Pricing | `/dashboard/costs/pricing` | — | missing-spa-route |
| observe | costs / Budget | `/dashboard/costs/budget` | budgets | partial-requires-behavior-review |
| observe | costs / Quota | `/dashboard/quota` | resilience | partial-requires-behavior-review |
| observe | costs / Quota sharing | `/dashboard/costs/quota-share` | budgets | partial-requires-behavior-review |
| observe | logs / Requests | `/dashboard/logs` | usage | partial-requires-behavior-review |
| observe | logs / Proxy | `/dashboard/logs/proxy` | — | missing-spa-route |
| observe | logs / Console | `/dashboard/logs/console` | — | missing-spa-route |
| observe | logs / Timeline | `/dashboard/logs/timeline` | — | missing-spa-route |
| observe | logs / Conversations | `/dashboard/conversations` | — | missing-spa-route |
| observe | logs / Activity | `/dashboard/activity` | usage | partial-requires-behavior-review |
| observe | audit / Audit log | `/dashboard/audit` | audit | partial-requires-behavior-review |
| observe | audit / MCP | `/dashboard/audit/mcp` | audit | partial-requires-behavior-review |
| observe | audit / A2A | `/dashboard/audit/a2a` | audit | partial-requires-behavior-review |
| observe | health / Health | `/dashboard/health` | overview | partial-requires-behavior-review |
| observe | health / Runtime | `/dashboard/runtime` | overview | partial-requires-behavior-review |
| observe | health / Connections | `/dashboard/resilience/connections` | resilience | partial-requires-behavior-review |
| observe | integrations / Webhooks | `/dashboard/webhooks` | usage-sinks | partial-requires-behavior-review |
| observe | integrations / Log export | `/dashboard/log-export` | usage-sinks | partial-requires-behavior-review |
| observe | integrations / Usage sinks | `/dashboard/usage-sinks` | usage-sinks | partial-requires-behavior-review |
| observe | integrations / API endpoints | `/dashboard/api-endpoints` | — | missing-spa-route |
| tools | playground / Playground | `/dashboard/playground` | playground | partial-requires-behavior-review |
| tools | translator / Translator | `/dashboard/translator` | — | missing-spa-route |
| tools | search-tools / Search tools | `/dashboard/search-tools` | — | missing-spa-route |
| tools | traffic-inspector / Inspector | `/dashboard/tools/traffic-inspector` | — | missing-spa-route |
| tools | discovery / Discovery | `/dashboard/discovery` | models | partial-requires-behavior-review |
| access | tenants / Tenants | `/dashboard/tenants` | organizations | partial-requires-behavior-review |
| access | access-users / Users | `/dashboard/users` | organizations | partial-requires-behavior-review |
| access | access-roles / Roles | `/dashboard/roles` | organizations | partial-requires-behavior-review |
| system | network / Network | `/dashboard/settings/network` | — | missing-spa-route |
| system | settings / Storage | `/dashboard/settings/general` | — | missing-spa-route |
| system | settings / Appearance | `/dashboard/settings/appearance` | — | missing-spa-route |
| system | settings / Prompts | `/dashboard/settings/prompts` | — | missing-spa-route |
| system | settings / AI | `/dashboard/settings/ai` | — | missing-spa-route |
| system | settings / Routing | `/dashboard/settings/routing` | — | missing-spa-route |
| system | settings / Resilience | `/dashboard/settings/resilience` | resilience | partial-requires-behavior-review |
| system | settings / Security | `/dashboard/settings/security` | oidc | partial-requires-behavior-review |
| system | settings / Advanced | `/dashboard/settings/advanced` | — | missing-spa-route |
| system | settings / Modality bridge | `/dashboard/settings/modality-bridge` | — | missing-spa-route |
| system | settings / Access tokens | `/dashboard/settings/access-tokens` | keys | partial-requires-behavior-review |
| system | settings / Feature flags | `/dashboard/settings/feature-flags` | — | missing-spa-route |
| system | settings / Cache | `/dashboard/settings/cache` | — | missing-spa-route |
| system | settings / Sidebar | `/dashboard/settings/sidebar` | — | missing-spa-route |
| system | settings / Outbound proxies | `/dashboard/system/proxy` | — | missing-spa-route |
| system | docs / Docs | `/docs` | — | external-link-review |
| system | issues / Issues | `https://github.com/reddb-io/red-router/issues` | — | external-link-review |
| system | chaos / Chaos mode | `/dashboard/chaos` | — | missing-spa-route |
| system | batch / Batch jobs | `/dashboard/batch` | — | missing-spa-route |
| system | batch / Files | `/dashboard/batch/files` | — | missing-spa-route |

## Every API domain

Exact normalized path matches do not prove method, authorization or payload compatibility. No match may mean a renamed Rust API. Inspect the full per-route JSON and the backlog's explicit replacements.

| Historical API domain | Route files | Same-path Rust candidates |
| --- | ---: | ---: |
| [...omnirouteApiCatchAll] | 1 | 0 |
| a2a | 5 | 0 |
| access | 1 | 0 |
| acp | 1 | 0 |
| admin | 2 | 0 |
| agent-skills | 5 | 0 |
| analytics | 3 | 0 |
| assess | 1 | 0 |
| auth | 15 | 3 |
| batches | 2 | 0 |
| branding | 1 | 0 |
| budgets | 3 | 0 |
| cache | 5 | 0 |
| chaos | 2 | 0 |
| cli | 4 | 0 |
| cli-tools | 32 | 0 |
| cloud | 4 | 0 |
| codex | 1 | 0 |
| combos | 11 | 0 |
| compliance | 1 | 1 |
| compression | 7 | 0 |
| conductor | 5 | 0 |
| context | 14 | 0 |
| conversations | 3 | 0 |
| copilot | 1 | 0 |
| cursor-cli | 1 | 0 |
| dahl | 1 | 0 |
| db | 1 | 0 |
| db-backups | 4 | 0 |
| discovery | 4 | 0 |
| docs | 2 | 0 |
| evals | 4 | 0 |
| fallback | 1 | 0 |
| files | 2 | 0 |
| free-models | 1 | 0 |
| free-provider-rankings | 1 | 0 |
| free-tier | 1 | 0 |
| github-skills | 1 | 0 |
| guardrails | 3 | 0 |
| headroom | 3 | 0 |
| health | 3 | 0 |
| init | 1 | 0 |
| intelligence | 1 | 0 |
| internal | 1 | 0 |
| issue-agent | 1 | 0 |
| jobs | 5 | 0 |
| keys | 11 | 0 |
| local | 4 | 0 |
| log-export | 7 | 0 |
| logs | 5 | 0 |
| mcp | 7 | 0 |
| memory | 9 | 0 |
| metrics | 2 | 0 |
| middleware | 2 | 0 |
| modality-bridge | 4 | 0 |
| model-capability-overrides | 1 | 0 |
| model-combo-mappings | 2 | 0 |
| models | 6 | 0 |
| monitoring | 2 | 1 |
| network | 1 | 0 |
| oauth | 21 | 0 |
| omniroute | 2 | 0 |
| openapi | 2 | 0 |
| playground | 5 | 0 |
| plugins | 8 | 0 |
| policies | 1 | 0 |
| pricing | 4 | 0 |
| provider-metrics | 1 | 0 |
| provider-models | 1 | 0 |
| provider-nodes | 3 | 0 |
| provider-stats | 1 | 0 |
| providers | 59 | 12 |
| proxy-fallback | 1 | 0 |
| quota | 11 | 0 |
| radar | 11 | 0 |
| rate-limit | 1 | 0 |
| rate-limits | 1 | 0 |
| relay | 2 | 0 |
| resilience | 4 | 0 |
| restart | 1 | 0 |
| routing | 5 | 0 |
| search | 2 | 0 |
| services | 58 | 0 |
| session-pools | 2 | 0 |
| sessions | 1 | 0 |
| settings | 91 | 0 |
| setup | 1 | 0 |
| shutdown | 1 | 0 |
| skills | 11 | 0 |
| storage | 1 | 0 |
| sync | 5 | 0 |
| synced-available-models | 1 | 0 |
| system | 4 | 0 |
| tags | 1 | 0 |
| telegram | 1 | 0 |
| telemetry | 1 | 0 |
| tenant | 5 | 0 |
| tenants | 12 | 0 |
| token-health | 1 | 0 |
| tools | 36 | 0 |
| translator | 5 | 0 |
| tunnels | 17 | 0 |
| upstream-proxy | 1 | 0 |
| usage | 31 | 1 |
| usage-sinks | 6 | 4 |
| v1 | 113 | 6 |
| v1beta | 2 | 0 |
| version-manager | 6 | 0 |
| vnc-session | 2 | 0 |
| webhooks | 5 | 0 |
