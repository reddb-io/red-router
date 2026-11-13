# Rustify legacy-to-Rust audit

Feature implementation remains paused. This is an analysis deliverable, not release acceptance.

- Legacy: `525a71de4ac25968d0a25e52eeb1b09cc21c6e92`
- Current source: `8ccd4a21c949fb6b502ec8f412b4f0af66d6fbd5` (also record exact Rust hashes in JSON)
- Rustify: [`bbf9ac726e4fbf511a77a4c9e818cd8fb7f9bcb7`](https://github.com/ArchAstro/rustify/tree/bbf9ac726e4fbf511a77a4c9e818cd8fb7f9bcb7)
- Reproduce: `node scripts/research/rustify-parity.mjs <clean-pinned-rustify-checkout> <rustify-binary>`
- Full per-file evidence, import edits, unresolved imports, tests, graph dependencies, API routes and hashes: [rustify-parity.json](../../config/upstream/rustify-parity.json).

## Interpretation

Rustify graph/status/next/e2e actually ran on an isolated synthetic Git repository. The adapter reads the historical tsconfig and resolves literal imports with TypeScript, rewriting only the disposable copy. No historical application code is executed. The synthetic package solves Rustify's workspace ownership requirement. Original blob IDs remain authoritative; adapted blobs must never be presented as the original provenance.

The index deliberately contains no certified ports. Existing implementations are candidate crosswalks from explicit backlog anchors and normalized exported symbol names; neither establishes behavioral equality. A missing candidate does not establish missing code. An existing Rust implementation may consolidate many legacy files. UI and shared files are included for dependency completeness but must not automatically be translated to Rust. The full tracked JS/TS file list includes tests/tooling outside runtime roots with explicit scope labels.

The graph does not fully resolve dynamic imports, non-code assets, generated files or missing dependencies. Inspect the unresolved lists before relying on batch order. The dependency-ready batches are technical ordering hints, not product priority. Our behavioral backlog remains authoritative. Rustify's process comparator does not verify SQLite contents or HTTP/SSE/browser behavior by itself. No tests, CI or application performance measurements were performed by this audit.

## Counts (not completion percentages)

```json
{
  "legacySourceFiles": 12962,
  "runtimeSourceFiles": 5374,
  "rustifyGraphFiles": 5750,
  "rustifyTestFiles": 6291,
  "rustSourceFiles": 50,
  "backendOrSharedFiles": 4824,
  "backendWithCandidate": 1320,
  "backendWithoutCandidate": 3504,
  "adaptedImports": 14556,
  "unresolvedLocalImports": 78,
  "dynamicImportExpressions": 203,
  "rustifyUnresolvedImports": 2,
  "runtimeFilesOutsideGraph": 0,
  "expectedInternalImportEdges": 18324,
  "missingInternalImportEdges": 0,
  "remainingAliasExternals": 0,
  "openFeatureRows": 71,
  "navigation": {
    "areas": 8,
    "navigationGroups": 33,
    "navigationSurfaces": 106,
    "spaPages": 15,
    "missingSpaRoutes": 69,
    "partialSpaRoutes": 35,
    "externalLinks": 2,
    "oldApiRouteFiles": 803,
    "rustRegisteredPaths": 90,
    "samePathCandidates": 28
  },
  "certifiedByThisAudit": 0,
  "dependencyUnits": 5474,
  "importCycles": 11,
  "largestImportCycle": 261
}
```

## All open feature fronts

Rows are inherited from the manually audited backlog, enriched with existing Rust paths. They are not automatically rediscovered functional requirements. See [provider field gaps](LEGACY_PROVIDER_PARITY_FIELDS.md) and [executor gaps](LEGACY_EXECUTOR_PARITY.md) for finer contracts.

| ID | Priority / complexity | Capability / state | Existing Rust candidates | Still required |
| --- | --- | --- | --- | --- |
| CORE-01 | P0 / M | Rail, panel, tabs, deep links — Partial | Trace separately | Restore the original 8-area taxonomy, entry tabs, breadcrumbs, search, visibility and mobile navigation as their features land. Do not expose dummy actions or count aliases as ports. Deep-link and keyboard E2E. |
| CORE-02 | P0 / M | Model/provider catalog — Partial | `catalog.rs` | Global/provider/type search, sorting, pagination and full capability/context/cache-price metadata are implemented; verify CI evidence below. Remaining: model/configuration links and complete freshness/retry parity. Distinguish listed metadata from configured/authorized providers. Bound rendering and avoid stale results after changing provider. |
| CORE-03 | P0 / L | Provider CRUD and advanced configuration — Partial | `control_plane.rs` | Field-by-field mapping of endpoint/auth/header/model/region/project/proxy settings. Preserve secrets on metadata edits; never return secrets in list responses. Test create/edit/test/disable/delete/reload for every supported transport. |
| CORE-04 | P0 / L | Provider OAuth accounts and sessions — Partial | `control_plane.rs` | Enumerate old provider auth flows separately from API-compatible IDs. Test authorize/callback/device/import/refresh/revoke, expired/banned states and competing refreshes. Keep Gemini CLI retired; preserve Antigravity. Use supported CLI integrations; never disguise clients to bypass provider controls. |
| CORE-05 | P0 / L | Named client keys and policies — Partial | `control_plane.rs`, `policy.rs` | Compare every policy field and route restriction, custom headers, schedules, groups/tags/users, key routing and identity propagation. Preserve tenant ownership and human-readable labels; no RedDB database ID coupling. Test allowed and denied requests, not just CRUD. |
| CORE-06 | P0 / L | Counters, token limits, spend and shared budgets — Partial | `accounting.rs`, `reconcile.rs`, `shared_budget.rs`, `shared_usage.rs` | Trace per-model limits (UI already exists), daily/monthly/reset windows, pending reservations and streaming disconnects. Preserve counters during cutover. Prove parallel-worker admission and exactly-once settlement without silently capping all agents. |
| CORE-07 | P0 / L | Combos and automatic routing — Partial | `control_plane.rs`, `product_combo.rs` | Separate native combo support from narrow legacy combo reader. Compare all strategies/config fields, prompts, fallback conditions, route pins, context relay and limits. Dedicated live/test-combo pages are missing; prefix aliases are not implementations. |
| CORE-08 | P0 / L | Account cooldown, provider breaker, model lockout — Partial | `availability.rs`, `circuit.rs`, `resilience.rs` | Trace each scope, Retry-After, half-open probes, quota reset and terminal account states. Test simultaneous failures do not repeatedly extend cooldown or retry unusable credentials. |
| CORE-09 | P0 / L | Existing data cutover — Partial / blocker | `legacy_archive.rs`, `legacy_cutover.rs`, `legacy_keys.rs`, `legacy_providers.rs`, `legacy_quota.rs` | Importers still reject legacy behaviors they cannot preserve; do not remove these checks. Inventory populated tables/settings, migrate supported rows transactionally, report unsupported fields, preserve ciphertext/key hashes and identity, rehearse backup/import/restart/rollback on disposable copies. An archive is not an operational port. |
| CORE-10 | P0 / L | Organization, membership, OIDC and provisioning — Partial | `control_plane.rs`, `oidc.rs` | Compare membership and fine-grained roles with current identity bindings. Users/roles aliases currently open Organizations. Test two tenants, issuer/subject mapping, key provisioning, revocation, CSRF/session expiry and cross-tenant denial. |
| CORE-11 | P0 / L | Usage/history/cost records — Partial | `native_usage.rs` | Verify model/key/provider/account/request attribution, pricing at request time, cached/reasoning tokens, filters/pagination, retention and drill-down. Aggregate usage does not replace logs/timeline/conversations. |
| CORE-12 | P0 / M | Production start, SPA serving and durable SQLite — Partial | `main.rs`, `spa.rs` | Test install, upgrade, base paths/deep links, persistent data directory, backups, shutdown/drain, authenticated SPA and no Node backend. Current local preview uses disposable data: do not restart/delete it during SPA updates. |
| UI-01 | P1 / S | Setup/onboarding | Trace separately | Connect initial configuration, provider setup and a successful authorized request; persist setup decisions. |
| UI-02 | P1 / M | Home topology | Trace separately | Actual provider/route topology and state, not generic health counters. |
| UI-03 | P1 / L | Usage analytics | Trace separately | Time series, filtering, grouping, comparison periods and exact token/cost dimensions from Rust queries. |
| UI-04 | P1 / M | Provider stats / utilization | Trace separately | Per-account/model/provider totals, success/latency/utilization; data isolation and bounded aggregation. |
| UI-05 | P1 / L | Combo health / live view / route trace | Trace separately | Decision reasons, fallback attempts, health and live updates without leaking credentials or other tenants. |
| UI-06 | P2 / L | Search analytics and evals | Trace separately | Persist datasets/evaluation runs and search metrics; import history; reliable status/error reporting. |
| UI-07 | P1 / M | Free tiers and provider rankings | Trace separately | Quota/free-tier metadata, ranking inputs/freshness and explicit unavailable-provider handling. |
| UI-08 | P2 / L | Radar | Trace separately | Discovery/sync/recommendations, admin controls and opt-in feature flag; no automatic entitlement assumption. |
| UI-09 | P1 / L | Local embedded services | Trace separately | Durable config plus lifecycle/health/logs; bounded supervision and clean stop. |
| UI-10 | P1 / L | Media provider management | Trace separately | Separate audio/image/video capabilities and credentials, model lists, pricing and diagnosis. |
| UI-11 | P2 / L | Relay | Trace separately | Port configured relay transport/auth/routing with explicit failures and loop protection. |
| UI-12 | P1 / L | MCP endpoint and tools | Trace separately | Inventory tool/scopes from baseline; supported transports, authentication, isolation, cancellation and audit. No placeholder endpoint tab. |
| UI-13 | P2 / L | A2A server and audit | Trace separately | Discovery, JSON-RPC tasks, streaming, cancellation, identity/scopes and durable task transitions. |
| UI-14 | P1 / XL | Token saver / compression engines | Trace separately | Port each engine/config (Caveman, RTK, Headroom, session dedup, CCR, LLMLingua, Lite, Aggressive, Ultra, Omniglyph), limits, opt-in exclusions and accurate savings. Do not silently alter prompt semantics. |
| UI-15 | P1 / L | Compression combos/studio/live/analytics | Trace separately | Persist experiments/settings, apply pipeline, compare input/output and measured tokens; stream bounded telemetry. |
| UI-16 | P1 / L | Response/cache management and cache health | Trace separately | Key construction, tenant/policy separation, TTL, invalidation, counters and inspection; never cache private traffic across tenants. |
| UI-17 | P1 / L | Media cache | Trace separately | Durable objects/metadata, limits/eviction, range/content handling and ownership-aware access. |
| UI-18 | P2 / L | Skills/catalog/prompt styles | Trace separately | CRUD/import/export, version/activation, scope, injection rules and durable configuration. |
| UI-19 | P2 / XL | Conversation memory | Trace separately | Persist/search/retain/delete with tenant boundaries; reproduce injection and retrieval behavior, bounded resource use. |
| UI-20 | P1 / L | CLI code integrations | Trace separately | Configure supported CLI endpoint/model/key without credential exposure; reversible settings and connection validation. |
| UI-21 | P2 / XL | CLI agents / ACP / cloud agents | Trace separately | Inventory each adapter, durable jobs, subprocess supervision, cancellation and secret handling. |
| UI-22 | P2 / XL | Conductor / orchestration | Trace separately | Workflow DAG/task state, recovery after restart, concurrency, logs and permissions. |
| UI-23 | P2 / L | Agent bridge | Trace separately | Configured bridges, connection lifecycle, protocol mapping, access controls and diagnosis. |
| UI-24 | P2 / XL | Plugins | Trace separately | Manifest/installation/lifecycle/permissions with extension boundaries; do not execute arbitrary frontend plugins with backend privileges. |
| UI-25 | P1 / M | Pricing overrides | Trace separately | Tenant-scoped input/output/cache/reasoning/audio token prices now persist and feed native metering. Native and SPA/browser checks passed; legacy parity gaps below remain open. Dedicated pricing navigation, sync/source provenance, all legacy pricing rules and conflict-safe import remain open; catalog list prices alone are insufficient. |
| UI-26 | P1 / M | Provider quota view | Trace separately | Restore account/model windows, auto-refresh settings and quota sharing semantics beyond shared monetary budgets. |
| UI-27 | P1 / L | Request/proxy/console logs | Trace separately | Bounded searchable records, request detail, redaction, retention and live tail. No infinite memory buffers. |
| UI-28 | P1 / L | Timeline / conversations / activity | Trace separately | Reconstruct correlated requests/messages with permission-aware payload retention and deletion. |
| UI-29 | P1 / M | Audit log | `audit_export.rs` | Compare old filters, event taxonomy, actor/resource attribution, export; MCP/A2A tabs require those domains, not a generic audit prefix. |
| UI-30 | P1 / M | Health / runtime / connections | Trace separately | Component/resource details, readiness and actual dependency failure, worker state and bounded diagnostics. |
| UI-31 | P1 / L | Generic event webhooks | Trace separately | Separate event subscriptions from usage exports; signed delivery, retries, backoff, replay/outbox and safe destination handling. |
| UI-32 | P1 / M | Log export / usage sinks / BigQuery | `audit_export.rs`, `kafka_export.rs`, `native_usage.rs` | Verify each configured destination and delivery schema including model, key identifier, organization, tokens/costs, deduplication and retry. Usage sinks do not establish generic log-export parity. |
| UI-33 | P1 / S | API endpoint explorer | Trace separately | Enumerate actual endpoints/methods/auth, examples and versioned schemas; do not advertise unsupported protocols. |
| UI-34 | P1 / M | Playground | Trace separately | Text multi-turn/stream/cancel and key-scoped model discovery exist. Still port system/generation controls, history, compare/API tabs, attachments/tool output and metrics; no browser-secret persistence. |
| UI-35 | P1 / M | Translator UI | Trace separately | Explicit source/target protocol conversion, structured errors and examples driven by actual Rust translators. |
| UI-36 | P1 / L | Search tools and web fetch | Trace separately | Provider transport/results, query/fetch schemas, credits/costs, timeouts and search-specific credential settings. |
| UI-37 | P2 / L | Traffic inspector | Trace separately | Scoped capture/filter/replay with payload retention, sanitization and bounded buffers. |
| UI-38 | P1 / M | Discovery | Trace separately | Runtime capability/endpoint/key discovery already has Rust routes. Add actual explorer and distinguish metadata, configured endpoints and authorized capabilities. |
| UI-39 | P1 / L | Network / tunnels / outbound proxies | Trace separately | Persist proxy selection per connection, tunnel lifecycle, diagnostics, credential secrecy and SSRF boundaries. |
| UI-40 | P0 / M | Storage/general settings | Trace separately | Backend/data-directory visibility, backup/restore/migration status; no silent storage failover. |
| UI-41 | P1 / S | Appearance and sidebar settings | Trace separately | Theme/density/navigation visibility, persisted preferences and migration of old hidden IDs. |
| UI-42 | P1 / M | Prompt and AI settings | Trace separately | Persist/retrieve defaults and prove where they affect requests; prevent inert form controls. |
| UI-43 | P0 / L | Routing / advanced settings | Trace separately | Compare every setting to legacy `/api/settings` consumers; unsupported fields must be reported during import. |
| UI-44 | P0 / L | Security settings beyond OIDC | Trace separately | Session/API auth controls, guardrails and policy settings are distinct from OIDC. Preserve opt-in PII defaults and authorization enforcement. |
| UI-45 | P1 / M | Feature flags | Trace separately | Definitions, safe defaults, scoped overrides, runtime effects and migration. No feature declared available because its flag exists. |
| UI-46 | P2 / L | Modality bridge | Trace separately | Explicit conversion paths, supported providers, accounting and cancellation; error on unsupported combinations. |
| UI-47 | P2 / L | Chaos mode | Trace separately | Scoped fault injection with explicit opt-in, reset and observability; never enabled in production by migration. |
| UI-48 | P1 / L | Batch jobs and files | Trace separately | Upload/storage/ownership, job lifecycle, polling/cancellation, durable results and metering. |
| UI-49 | P1 / M | Docs/help links | Trace separately | Docs must describe the actual installed product/API; issue links are links, not migrated backend features. |
| API-01 | P0 / L | Every protocol's request/response and error contracts | `translation.rs` | `src/app/api/v1/`, `open-sse/translator/`, `open-sse/transformer/` → `translation.rs`, stream modules. Golden fixtures for roles, tool calls, reasoning, structured output, token usage and all terminal stream forms. Chat, Responses, Messages, Gemini, embeddings and rerank Rust routes exist; equivalence is partial. |
| API-02 | P1 / L | Audio/TTS/transcription, image/video and multimodal routes | Trace separately | Compare all baseline v1 route files, media registries and executors. Current router does not expose these families. Require provider-specific multipart/binary/stream tests and accounting. |
| API-03 | P1 / L | Search/fetch, files, batches and remaining v1 protocols | Trace separately | Enumerate exact method contracts from the JSON inventory. No path/count-only parity claims; transformed APIs need explicit compatibility mapping. |
| API-04 | P0 / XL | Provider transport/auth coverage | `product_provider.rs` | Inventory all old executor files (included in JSON), then map provider→auth→endpoint→protocol→model normalization→fallback→quota. `product_provider.rs` explicitly implements a narrow compatible-chat subset. Generic base URL support is not a native provider port. |
| API-05 | P0 / L | Legacy field compatibility and unsupported-policy migration | `legacy_keys.rs`, `product_combo.rs` | `legacy_keys.rs` rejects nonempty unsupported fields; `product_combo.rs` has narrower legacy semantics. Record each rejected field and implement before lifting rejection. Disabled imports and archived tables do not fulfill live parity. |
| API-06 | P1 / L | Guardrails/hooks/PII/security policy | Trace separately | `src/lib/guardrails/`, middleware registry, policy code. Tenant/realm isolation, deterministic order, opt-in data mutation and streaming correctness. |
| API-07 | P1 / L | Pricing/dynamic provider metadata refresh | Trace separately | Preserve request-time price snapshots, custom overrides and source provenance; catalog refresh must not change entitlements or retroactively rewrite costs. |
| API-08 | P0 / L | Data-domain completeness | Trace separately | All DB modules/migrations are enumerated in JSON. For each populated domain choose live migration or explicit unsupported blocker. Require idempotent import, counter reconciliation and rollback evidence; never silently discard. |
| API-09 | P0 / L | Durable side effects and background workers | Trace separately | Outbox reservation/delivery, cleanup, refresh, reconciliation and supervision; replay/restart/concurrency tests across two processes sharing SQLite. |
| API-10 | P0 / M | Measured latency, memory and concurrency | Trace separately | Compare old/new at same workload, provider stub and machine: cold/warm memory, TTFT, p50/p95/p99, throughput, slow clients, cancellation, long streams. Use existing CI performance suite; frontend completion does not prove performance. |

## Every missing SPA navigation surface

| Area | Group | Historical route |
| --- | --- | --- |
| home | analytics | `/dashboard/analytics/combo-health` |
| home | analytics | `/dashboard/analytics/utilization` |
| home | analytics | `/dashboard/analytics/search` |
| home | analytics | `/dashboard/analytics/evals` |
| home | analytics | `/dashboard/analytics/cache-health` |
| home | analytics | `/dashboard/analytics/route-trace` |
| home | setup | `/dashboard/setup` |
| proxy | endpoint-keys | `/dashboard/mcp` |
| proxy | endpoint-keys | `/dashboard/a2a` |
| proxy | providers | `/dashboard/free-tiers` |
| proxy | providers | `/dashboard/free-provider-rankings` |
| proxy | providers | `/dashboard/radar` |
| proxy | providers | `/dashboard/media-providers` |
| proxy | providers | `/dashboard/relay` |
| optimize | token-saver | `/dashboard/context/settings` |
| optimize | token-saver | `/dashboard/context/engines` |
| optimize | token-saver | `/dashboard/context/caveman` |
| optimize | token-saver | `/dashboard/context/rtk` |
| optimize | token-saver | `/dashboard/context/headroom` |
| optimize | token-saver | `/dashboard/context/session-dedup` |
| optimize | token-saver | `/dashboard/context/ccr` |
| optimize | token-saver | `/dashboard/context/llmlingua` |
| optimize | token-saver | `/dashboard/context/lite` |
| optimize | token-saver | `/dashboard/context/aggressive` |
| optimize | token-saver | `/dashboard/context/ultra` |
| optimize | token-saver | `/dashboard/context/omniglyph` |
| optimize | token-saver | `/dashboard/context/combos` |
| optimize | token-saver | `/dashboard/compression/studio` |
| optimize | token-saver | `/dashboard/compression/exclusions` |
| optimize | token-saver | `/dashboard/compression/live` |
| optimize | token-saver | `/dashboard/analytics/compression` |
| optimize | cache | `/dashboard/cache` |
| optimize | cache | `/dashboard/cache/media` |
| optimize | skills | `/dashboard/skills` |
| optimize | skills | `/dashboard/agent-skills` |
| optimize | skills | `/dashboard/skills/styles` |
| optimize | memory | `/dashboard/memory` |
| agents | agents | `/dashboard/cli-code` |
| agents | agents | `/dashboard/cli-agents` |
| agents | agents | `/dashboard/acp-agents` |
| agents | agents | `/dashboard/cloud-agents` |
| agents | conductor | `/dashboard/conductor` |
| agents | conductor | `/dashboard/orchestration` |
| agents | agent-bridge | `/dashboard/tools/agent-bridge` |
| agents | plugins | `/dashboard/plugins` |
| observe | costs | `/dashboard/costs/pricing` |
| observe | logs | `/dashboard/logs/proxy` |
| observe | logs | `/dashboard/logs/console` |
| observe | logs | `/dashboard/logs/timeline` |
| observe | logs | `/dashboard/conversations` |
| observe | integrations | `/dashboard/api-endpoints` |
| tools | translator | `/dashboard/translator` |
| tools | search-tools | `/dashboard/search-tools` |
| tools | traffic-inspector | `/dashboard/tools/traffic-inspector` |
| system | network | `/dashboard/settings/network` |
| system | settings | `/dashboard/settings/general` |
| system | settings | `/dashboard/settings/appearance` |
| system | settings | `/dashboard/settings/prompts` |
| system | settings | `/dashboard/settings/ai` |
| system | settings | `/dashboard/settings/routing` |
| system | settings | `/dashboard/settings/advanced` |
| system | settings | `/dashboard/settings/modality-bridge` |
| system | settings | `/dashboard/settings/feature-flags` |
| system | settings | `/dashboard/settings/cache` |
| system | settings | `/dashboard/settings/sidebar` |
| system | settings | `/dashboard/system/proxy` |
| system | chaos | `/dashboard/chaos` |
| system | batch | `/dashboard/batch` |
| system | batch | `/dashboard/batch/files` |

## Backend and shared module groups

Candidate means investigation evidence only. The JSON enumerates every file, dependency, historical test and candidate.

| Legacy group | Files | With Rust candidates | Without candidates |
| --- | ---: | ---: | ---: |
| bin/aliasResolver.mjs | 1 | 0 | 1 |
| bin/antigravity-bridge.mjs | 1 | 0 | 1 |
| bin/chatgpt-web-codex-mcp.mjs | 1 | 0 | 1 |
| bin/cli/api-commands | 32 | 0 | 32 |
| bin/cli/api.mjs | 1 | 1 | 0 |
| bin/cli/cli-manifest.mjs | 1 | 0 | 1 |
| bin/cli/commands | 90 | 0 | 90 |
| bin/cli/contexts.mjs | 1 | 0 | 1 |
| bin/cli/data-dir.mjs | 1 | 0 | 1 |
| bin/cli/encryption.mjs | 1 | 0 | 1 |
| bin/cli/i18n.mjs | 1 | 0 | 1 |
| bin/cli/io.mjs | 1 | 0 | 1 |
| bin/cli/mcpClient.mjs | 1 | 0 | 1 |
| bin/cli/model-preferences.mjs | 1 | 0 | 1 |
| bin/cli/npm-exec.mjs | 1 | 0 | 1 |
| bin/cli/output.mjs | 1 | 0 | 1 |
| bin/cli/plugins.mjs | 1 | 0 | 1 |
| bin/cli/private-file.mjs | 1 | 0 | 1 |
| bin/cli/privateDataDir.mjs | 1 | 0 | 1 |
| bin/cli/product.mjs | 1 | 0 | 1 |
| bin/cli/program.mjs | 1 | 0 | 1 |
| bin/cli/provider-catalog.mjs | 1 | 0 | 1 |
| bin/cli/provider-store.mjs | 1 | 0 | 1 |
| bin/cli/provider-test.mjs | 1 | 0 | 1 |
| bin/cli/recovery | 3 | 0 | 3 |
| bin/cli/runtime | 7 | 0 | 7 |
| bin/cli/runtime.mjs | 1 | 0 | 1 |
| bin/cli/schemas | 1 | 0 | 1 |
| bin/cli/service.mjs | 1 | 0 | 1 |
| bin/cli/settings-store.mjs | 1 | 0 | 1 |
| bin/cli/spinner.mjs | 1 | 0 | 1 |
| bin/cli/sqlite.mjs | 1 | 0 | 1 |
| bin/cli/tray | 11 | 0 | 11 |
| bin/cli/tui | 1 | 0 | 1 |
| bin/cli/utils | 12 | 0 | 12 |
| bin/mcp-server.mjs | 1 | 0 | 1 |
| bin/nodeRuntimeSupport.mjs | 1 | 0 | 1 |
| open-sse/config/agyModels.ts | 1 | 0 | 1 |
| open-sse/config/anthropicHeaders.ts | 1 | 1 | 0 |
| open-sse/config/antigravityModelAliases.ts | 1 | 0 | 1 |
| open-sse/config/antigravitySharedModels.ts | 1 | 0 | 1 |
| open-sse/config/antigravityUpstream.ts | 1 | 0 | 1 |
| open-sse/config/audioRegistry.ts | 1 | 0 | 1 |
| open-sse/config/azureAi.ts | 1 | 0 | 1 |
| open-sse/config/bedrock.ts | 1 | 0 | 1 |
| open-sse/config/claudeCodeCompatibleIdentity.ts | 1 | 0 | 1 |
| open-sse/config/claudeWebFingerprint.ts | 1 | 0 | 1 |
| open-sse/config/cliFingerprints.ts | 1 | 0 | 1 |
| open-sse/config/codexClient.ts | 1 | 0 | 1 |
| open-sse/config/codexIdentity.ts | 1 | 0 | 1 |
| open-sse/config/codexInstructions.ts | 1 | 0 | 1 |
| open-sse/config/codexQuotaScopes.ts | 1 | 0 | 1 |
| open-sse/config/codexTurnState.ts | 1 | 0 | 1 |
| open-sse/config/connectionBillingCatalog.ts | 1 | 0 | 1 |
| open-sse/config/constants.ts | 1 | 1 | 0 |
| open-sse/config/context1m.ts | 1 | 0 | 1 |
| open-sse/config/contextEditing.ts | 1 | 0 | 1 |
| open-sse/config/credentialLoader.ts | 1 | 0 | 1 |
| open-sse/config/datarobot.ts | 1 | 0 | 1 |
| open-sse/config/decisionSignals.ts | 1 | 0 | 1 |
| open-sse/config/defaultThinkingSignature.ts | 1 | 0 | 1 |
| open-sse/config/dynamicImageModelSources.ts | 1 | 0 | 1 |
| open-sse/config/embeddingRegistry.ts | 1 | 0 | 1 |
| open-sse/config/errorConfig.ts | 1 | 0 | 1 |
| open-sse/config/freeModelCatalog.data.ts | 1 | 0 | 1 |
| open-sse/config/freeModelCatalog.ts | 1 | 0 | 1 |
| open-sse/config/freeTierCatalog.ts | 1 | 0 | 1 |
| open-sse/config/freeTierProviders.ts | 1 | 0 | 1 |
| open-sse/config/gatewayProviders.ts | 1 | 0 | 1 |
| open-sse/config/glmProvider.ts | 1 | 0 | 1 |
| open-sse/config/grokBuild.ts | 1 | 0 | 1 |
| open-sse/config/imageRegistry.ts | 1 | 0 | 1 |
| open-sse/config/jev.ts | 1 | 0 | 1 |
| open-sse/config/maritalk.ts | 1 | 0 | 1 |
| open-sse/config/mediaServiceKinds.ts | 1 | 0 | 1 |
| open-sse/config/moderationRegistry.ts | 1 | 0 | 1 |
| open-sse/config/museCode.ts | 1 | 0 | 1 |
| open-sse/config/musicRegistry.ts | 1 | 0 | 1 |
| open-sse/config/nimble.ts | 1 | 0 | 1 |
| open-sse/config/oci.ts | 1 | 0 | 1 |
| open-sse/config/ocrRegistry.ts | 1 | 0 | 1 |
| open-sse/config/ollamaModels.ts | 1 | 0 | 1 |
| open-sse/config/opencodeZenGoSharedModels.ts | 1 | 0 | 1 |
| open-sse/config/providerErrorRules.ts | 1 | 0 | 1 |
| open-sse/config/providerFieldStrips.ts | 1 | 0 | 1 |
| open-sse/config/providerHeaderProfiles.ts | 1 | 1 | 0 |
| open-sse/config/providerModels.ts | 1 | 1 | 0 |
| open-sse/config/providerPluginManifest.ts | 1 | 0 | 1 |
| open-sse/config/providerPluginManifestRegistry.ts | 1 | 0 | 1 |
| open-sse/config/providerPluginManifestUrl.ts | 1 | 0 | 1 |
| open-sse/config/providerRegistry.ts | 1 | 0 | 1 |
| open-sse/config/providers | 306 | 1 | 305 |
| open-sse/config/redRouter.ts | 1 | 0 | 1 |
| open-sse/config/registryUtils.ts | 1 | 0 | 1 |
| open-sse/config/rerankRegistry.ts | 1 | 0 | 1 |
| open-sse/config/runway.ts | 1 | 0 | 1 |
| open-sse/config/sap.ts | 1 | 0 | 1 |
| open-sse/config/searchRegistry.ts | 1 | 0 | 1 |
| open-sse/config/semanticCacheConfig.ts | 1 | 0 | 1 |
| open-sse/config/systemOneRegistry.ts | 1 | 0 | 1 |
| open-sse/config/toolCloaking.ts | 1 | 0 | 1 |
| open-sse/config/upscaleRegistry.ts | 1 | 0 | 1 |
| open-sse/config/upstreamStatusRestatement.ts | 1 | 0 | 1 |
| open-sse/config/vertexModels.ts | 1 | 0 | 1 |
| open-sse/config/videoRegistry.ts | 1 | 0 | 1 |
| open-sse/config/watsonx.ts | 1 | 0 | 1 |
| open-sse/config/windsurfModels.ts | 1 | 0 | 1 |
| open-sse/decision/clientHint.ts | 1 | 0 | 1 |
| open-sse/decision/contextProbe.ts | 1 | 0 | 1 |
| open-sse/decision/decide.ts | 1 | 0 | 1 |
| open-sse/decision/injectHint.ts | 1 | 0 | 1 |
| open-sse/decision/jev.ts | 1 | 0 | 1 |
| open-sse/decision/localScorer.ts | 1 | 0 | 1 |
| open-sse/decision/modelBriefs.ts | 1 | 0 | 1 |
| open-sse/decision/questions.ts | 1 | 0 | 1 |
| open-sse/decision/reasoningAutopilot.ts | 1 | 0 | 1 |
| open-sse/decision/signals.ts | 1 | 0 | 1 |
| open-sse/decision/state.ts | 1 | 0 | 1 |
| open-sse/decision/tools.ts | 1 | 0 | 1 |
| open-sse/executors/accountRotation.ts | 1 | 1 | 0 |
| open-sse/executors/adapta-web.ts | 1 | 1 | 0 |
| open-sse/executors/adobe-firefly.ts | 1 | 1 | 0 |
| open-sse/executors/antigravity | 4 | 4 | 0 |
| open-sse/executors/antigravity.ts | 1 | 1 | 0 |
| open-sse/executors/antigravityOutputCap.ts | 1 | 1 | 0 |
| open-sse/executors/antigravityUpstreamError.ts | 1 | 1 | 0 |
| open-sse/executors/anysearch-fetch.ts | 1 | 1 | 0 |
| open-sse/executors/auggie.ts | 1 | 1 | 0 |
| open-sse/executors/awsPollyTts.ts | 1 | 1 | 0 |
| open-sse/executors/azure-ai.ts | 1 | 1 | 0 |
| open-sse/executors/azure-openai.ts | 1 | 1 | 0 |
| open-sse/executors/azureParamRules.ts | 1 | 1 | 0 |
| open-sse/executors/base | 4 | 4 | 0 |
| open-sse/executors/base.ts | 1 | 1 | 0 |
| open-sse/executors/bedrock.ts | 1 | 1 | 0 |
| open-sse/executors/blackbox-web.ts | 1 | 1 | 0 |
| open-sse/executors/browserExecutableCheck.ts | 1 | 1 | 0 |
| open-sse/executors/chatgpt-web-codex | 6 | 6 | 0 |
| open-sse/executors/chatgpt-web-codex.ts | 1 | 1 | 0 |
| open-sse/executors/chatgpt-web.ts | 1 | 1 | 0 |
| open-sse/executors/chatgptWebTools.ts | 1 | 1 | 0 |
| open-sse/executors/cheaperinference.ts | 1 | 1 | 0 |
| open-sse/executors/claude-web | 5 | 5 | 0 |
| open-sse/executors/claude-web.ts | 1 | 1 | 0 |
| open-sse/executors/claudeIdentity.ts | 1 | 1 | 0 |
| open-sse/executors/claudeUsageLimit.ts | 1 | 1 | 0 |
| open-sse/executors/cliproxyapi.ts | 1 | 1 | 0 |
| open-sse/executors/cloudflare-ai.ts | 1 | 1 | 0 |
| open-sse/executors/cloudflare-playground.ts | 1 | 1 | 0 |
| open-sse/executors/clova-studio.ts | 1 | 1 | 0 |
| open-sse/executors/codebuddy-cn.ts | 1 | 1 | 0 |
| open-sse/executors/codebuddy-intl.ts | 1 | 1 | 0 |
| open-sse/executors/codex | 12 | 12 | 0 |
| open-sse/executors/codex-app-server.ts | 1 | 1 | 0 |
| open-sse/executors/codex.ts | 1 | 1 | 0 |
| open-sse/executors/commandCode | 1 | 1 | 0 |
| open-sse/executors/commandCode.ts | 1 | 1 | 0 |
| open-sse/executors/conol-web.ts | 1 | 1 | 0 |
| open-sse/executors/context7-fetch.ts | 1 | 1 | 0 |
| open-sse/executors/copilot-m365-connection.ts | 1 | 1 | 0 |
| open-sse/executors/copilot-m365-frames.ts | 1 | 1 | 0 |
| open-sse/executors/copilot-m365-web.ts | 1 | 1 | 0 |
| open-sse/executors/copilot-web.ts | 1 | 1 | 0 |
| open-sse/executors/copilotIdentityFallback.ts | 1 | 1 | 0 |
| open-sse/executors/credential.ts | 1 | 1 | 0 |
| open-sse/executors/cursor | 9 | 9 | 0 |
| open-sse/executors/cursor.ts | 1 | 1 | 0 |
| open-sse/executors/dario.ts | 1 | 1 | 0 |
| open-sse/executors/deepseek-web | 1 | 1 | 0 |
| open-sse/executors/deepseek-web-done-terminator.ts | 1 | 1 | 0 |
| open-sse/executors/deepseek-web-with-auto-refresh.ts | 1 | 1 | 0 |
| open-sse/executors/deepseek-web.ts | 1 | 1 | 0 |
| open-sse/executors/default | 5 | 5 | 0 |
| open-sse/executors/default.ts | 1 | 1 | 0 |
| open-sse/executors/defaultResolver.ts | 1 | 1 | 0 |
| open-sse/executors/devin-agentic | 4 | 4 | 0 |
| open-sse/executors/devin-cli-agentic.ts | 1 | 1 | 0 |
| open-sse/executors/devin-cli.ts | 1 | 1 | 0 |
| open-sse/executors/devin-desktop.ts | 1 | 1 | 0 |
| open-sse/executors/doubao-web.ts | 1 | 1 | 0 |
| open-sse/executors/duckduckgo-web | 2 | 2 | 0 |
| open-sse/executors/duckduckgo-web.ts | 1 | 1 | 0 |
| open-sse/executors/edgeTts.ts | 1 | 1 | 0 |
| open-sse/executors/exa-fetch.ts | 1 | 1 | 0 |
| open-sse/executors/firecrawl-fetch.ts | 1 | 1 | 0 |
| open-sse/executors/fishAudioTts.ts | 1 | 1 | 0 |
| open-sse/executors/forceResponsesUpstream.ts | 1 | 1 | 0 |
| open-sse/executors/freebuff.ts | 1 | 1 | 0 |
| open-sse/executors/gemini-web | 3 | 3 | 0 |
| open-sse/executors/gemini-web.ts | 1 | 1 | 0 |
| open-sse/executors/geminiTts.ts | 1 | 1 | 0 |
| open-sse/executors/ghe-copilot.ts | 1 | 1 | 0 |
| open-sse/executors/github.ts | 1 | 1 | 0 |
| open-sse/executors/gitlab.ts | 1 | 1 | 0 |
| open-sse/executors/gitlabResponses.ts | 1 | 1 | 0 |
| open-sse/executors/glm.ts | 1 | 1 | 0 |
| open-sse/executors/grok-cli.ts | 1 | 1 | 0 |
| open-sse/executors/grok-web | 4 | 4 | 0 |
| open-sse/executors/grok-web.ts | 1 | 1 | 0 |
| open-sse/executors/grokCliAdditionalTools.ts | 1 | 1 | 0 |
| open-sse/executors/grokCliCustomTools.ts | 1 | 1 | 0 |
| open-sse/executors/grokCliNamespaceTools.ts | 1 | 1 | 0 |
| open-sse/executors/grokCliReasoningReplay.ts | 1 | 1 | 0 |
| open-sse/executors/grokCliToolSchema.ts | 1 | 1 | 0 |
| open-sse/executors/gtts.ts | 1 | 1 | 0 |
| open-sse/executors/huggingchat | 1 | 1 | 0 |
| open-sse/executors/huggingchat.ts | 1 | 1 | 0 |
| open-sse/executors/hyperagent.ts | 1 | 1 | 0 |
| open-sse/executors/iflow.ts | 1 | 1 | 0 |
| open-sse/executors/index.ts | 1 | 1 | 0 |
| open-sse/executors/inner-ai.ts | 1 | 1 | 0 |
| open-sse/executors/jina-reader-fetch.ts | 1 | 1 | 0 |
| open-sse/executors/kie.ts | 1 | 1 | 0 |
| open-sse/executors/kimchi.ts | 1 | 1 | 0 |
| open-sse/executors/kimi-web.ts | 1 | 1 | 0 |
| open-sse/executors/kimi.ts | 1 | 1 | 0 |
| open-sse/executors/kimiToolNames.ts | 1 | 1 | 0 |
| open-sse/executors/kiro | 1 | 1 | 0 |
| open-sse/executors/kiro.ts | 1 | 1 | 0 |
| open-sse/executors/kiroThinking.ts | 1 | 1 | 0 |
| open-sse/executors/kiroToolCallValidation.ts | 1 | 1 | 0 |
| open-sse/executors/lmarena | 5 | 5 | 0 |
| open-sse/executors/lmarena.ts | 1 | 1 | 0 |
| open-sse/executors/localDevice.ts | 1 | 1 | 0 |
| open-sse/executors/maxai | 10 | 10 | 0 |
| open-sse/executors/maxai.ts | 1 | 1 | 0 |
| open-sse/executors/mimo-free.ts | 1 | 1 | 0 |
| open-sse/executors/moonshot.ts | 1 | 1 | 0 |
| open-sse/executors/muse-spark-web | 1 | 1 | 0 |
| open-sse/executors/muse-spark-web.ts | 1 | 1 | 0 |
| open-sse/executors/nimble-fetch.ts | 1 | 1 | 0 |
| open-sse/executors/ninerouter.ts | 1 | 1 | 0 |
| open-sse/executors/nlpcloud.ts | 1 | 1 | 0 |
| open-sse/executors/notion-web.ts | 1 | 1 | 0 |
| open-sse/executors/ollama-cloud-fetch.ts | 1 | 1 | 0 |
| open-sse/executors/ollama-local.ts | 1 | 1 | 0 |
| open-sse/executors/oneminai.ts | 1 | 1 | 0 |
| open-sse/executors/opencode.ts | 1 | 1 | 0 |
| open-sse/executors/opencodeAccountHealth.ts | 1 | 1 | 0 |
| open-sse/executors/opencodeAccountScope.ts | 1 | 1 | 0 |
| open-sse/executors/opencodeEgressThrottle.ts | 1 | 1 | 0 |
| open-sse/executors/opencodeFreeTierContract.ts | 1 | 1 | 0 |
| open-sse/executors/opencodeFreeTierRetry.ts | 1 | 1 | 0 |
| open-sse/executors/opencodeGeoBlock.ts | 1 | 1 | 0 |
| open-sse/executors/opencodeHeadersWait.ts | 1 | 1 | 0 |
| open-sse/executors/opencodeMuseSpark.ts | 1 | 1 | 0 |
| open-sse/executors/opencodeParkResume.ts | 1 | 1 | 0 |
| open-sse/executors/opencodeRateLimited.ts | 1 | 1 | 0 |
| open-sse/executors/opencodeRequestContext.ts | 1 | 1 | 0 |
| open-sse/executors/opencodeRequestShape.ts | 1 | 1 | 0 |
| open-sse/executors/opencodeResilienceNotes.ts | 1 | 1 | 0 |
| open-sse/executors/opencodeResponseBody.ts | 1 | 1 | 0 |
| open-sse/executors/opencodeResponsesStall.ts | 1 | 1 | 0 |
| open-sse/executors/opencodeToolObservation.ts | 1 | 1 | 0 |
| open-sse/executors/opencodeTransientFailure.ts | 1 | 1 | 0 |
| open-sse/executors/perplexity-web | 1 | 1 | 0 |
| open-sse/executors/perplexity-web.ts | 1 | 1 | 0 |
| open-sse/executors/poe-web.ts | 1 | 1 | 0 |
| open-sse/executors/pollinations.ts | 1 | 1 | 0 |
| open-sse/executors/promptql | 3 | 3 | 0 |
| open-sse/executors/promptql.ts | 1 | 1 | 0 |
| open-sse/executors/qoder-cn.ts | 1 | 1 | 0 |
| open-sse/executors/qoder.ts | 1 | 1 | 0 |
| open-sse/executors/rateLimitIntraRetry.ts | 1 | 1 | 0 |
| open-sse/executors/registry.ts | 1 | 1 | 0 |
| open-sse/executors/t3-chat-web.ts | 1 | 1 | 0 |
| open-sse/executors/tavily-fetch.ts | 1 | 1 | 0 |
| open-sse/executors/tencent-aistudio-web.ts | 1 | 1 | 0 |
| open-sse/executors/tinycms.ts | 1 | 1 | 0 |
| open-sse/executors/tinycmsDomMocks.ts | 1 | 1 | 0 |
| open-sse/executors/tinycmsSigner.ts | 1 | 1 | 0 |
| open-sse/executors/tinyfish-fetch.ts | 1 | 1 | 0 |
| open-sse/executors/trae.ts | 1 | 1 | 0 |
| open-sse/executors/uc | 10 | 10 | 0 |
| open-sse/executors/uc.ts | 1 | 1 | 0 |
| open-sse/executors/v0-vercel-web.ts | 1 | 1 | 0 |
| open-sse/executors/venice-web.ts | 1 | 1 | 0 |
| open-sse/executors/veoaifree-web.ts | 1 | 1 | 0 |
| open-sse/executors/vertex.ts | 1 | 1 | 0 |
| open-sse/executors/vertexMedia.ts | 1 | 1 | 0 |
| open-sse/executors/windsurf.ts | 1 | 1 | 0 |
| open-sse/executors/windsurfWire.ts | 1 | 1 | 0 |
| open-sse/executors/xai.ts | 1 | 1 | 0 |
| open-sse/executors/yuanbao-web.ts | 1 | 1 | 0 |
| open-sse/executors/zai-web | 3 | 3 | 0 |
| open-sse/executors/zai-web.ts | 1 | 1 | 0 |
| open-sse/executors/zcode.ts | 1 | 1 | 0 |
| open-sse/executors/zcodeProtocol.ts | 1 | 1 | 0 |
| open-sse/executors/zed-hosted.ts | 1 | 1 | 0 |
| open-sse/executors/zenmux-free.ts | 1 | 1 | 0 |
| open-sse/handlers/audioSpeech.ts | 1 | 0 | 1 |
| open-sse/handlers/audioTranscription.ts | 1 | 0 | 1 |
| open-sse/handlers/audioTranslation.ts | 1 | 0 | 1 |
| open-sse/handlers/autoComboCandidates.ts | 1 | 0 | 1 |
| open-sse/handlers/chatCore | 111 | 0 | 111 |
| open-sse/handlers/chatCore.ts | 1 | 0 | 1 |
| open-sse/handlers/clientDiscovery.ts | 1 | 0 | 1 |
| open-sse/handlers/cursorCliProxy.ts | 1 | 0 | 1 |
| open-sse/handlers/elevenLabsVoiceMap.ts | 1 | 0 | 1 |
| open-sse/handlers/embeddings.ts | 1 | 0 | 1 |
| open-sse/handlers/embeddingStructuredInput.ts | 1 | 0 | 1 |
| open-sse/handlers/imageErrorLog.ts | 1 | 0 | 1 |
| open-sse/handlers/imageGeneration | 22 | 0 | 22 |
| open-sse/handlers/imageGeneration.ts | 1 | 0 | 1 |
| open-sse/handlers/imageUpscale | 4 | 0 | 4 |
| open-sse/handlers/imageUpscale.ts | 1 | 0 | 1 |
| open-sse/handlers/jinaFoundation.ts | 1 | 0 | 1 |
| open-sse/handlers/mediaGeneration | 2 | 0 | 2 |
| open-sse/handlers/moderations.ts | 1 | 0 | 1 |
| open-sse/handlers/musicGeneration.ts | 1 | 0 | 1 |
| open-sse/handlers/ocr.ts | 1 | 0 | 1 |
| open-sse/handlers/openrouterTranscription.ts | 1 | 0 | 1 |
| open-sse/handlers/rerank.ts | 1 | 0 | 1 |
| open-sse/handlers/responseSanitizer | 2 | 0 | 2 |
| open-sse/handlers/responseSanitizer.ts | 1 | 0 | 1 |
| open-sse/handlers/responsesHandler.ts | 1 | 0 | 1 |
| open-sse/handlers/responseTranslator.ts | 1 | 0 | 1 |
| open-sse/handlers/search | 9 | 0 | 9 |
| open-sse/handlers/search.ts | 1 | 0 | 1 |
| open-sse/handlers/sseParser | 1 | 0 | 1 |
| open-sse/handlers/sseParser.ts | 1 | 0 | 1 |
| open-sse/handlers/systemOneCore.ts | 1 | 0 | 1 |
| open-sse/handlers/uc | 1 | 0 | 1 |
| open-sse/handlers/usageExtractor.ts | 1 | 0 | 1 |
| open-sse/handlers/videoGeneration | 14 | 0 | 14 |
| open-sse/handlers/videoGeneration.ts | 1 | 0 | 1 |
| open-sse/handlers/webFetch.ts | 1 | 0 | 1 |
| open-sse/index.ts | 1 | 1 | 0 |
| open-sse/lib/deepseek-pow-hash.js | 1 | 0 | 1 |
| open-sse/lib/deepseek-pow-worker.mjs | 1 | 0 | 1 |
| open-sse/lib/deepseek-pow.ts | 1 | 0 | 1 |
| open-sse/mcp-server/audit.ts | 1 | 0 | 1 |
| open-sse/mcp-server/catalog.ts | 1 | 0 | 1 |
| open-sse/mcp-server/descriptionCompressor.ts | 1 | 0 | 1 |
| open-sse/mcp-server/errorMessage.ts | 1 | 0 | 1 |
| open-sse/mcp-server/fetchTimeout.ts | 1 | 0 | 1 |
| open-sse/mcp-server/httpAuthContext.ts | 1 | 0 | 1 |
| open-sse/mcp-server/httpTransport.ts | 1 | 0 | 1 |
| open-sse/mcp-server/index.ts | 1 | 0 | 1 |
| open-sse/mcp-server/mcpCallerIdentity.ts | 1 | 0 | 1 |
| open-sse/mcp-server/radarCatalog.ts | 1 | 0 | 1 |
| open-sse/mcp-server/runtimeHeartbeat.ts | 1 | 0 | 1 |
| open-sse/mcp-server/schemas | 11 | 0 | 11 |
| open-sse/mcp-server/scopeEnforcement.ts | 1 | 0 | 1 |
| open-sse/mcp-server/server.ts | 1 | 0 | 1 |
| open-sse/mcp-server/toolCardinality.ts | 1 | 0 | 1 |
| open-sse/mcp-server/toolCount.ts | 1 | 0 | 1 |
| open-sse/mcp-server/toolResult.ts | 1 | 0 | 1 |
| open-sse/mcp-server/tools | 12 | 0 | 12 |
| open-sse/mcp-server/toolSearch | 6 | 0 | 6 |
| open-sse/services/accountFallback | 8 | 8 | 0 |
| open-sse/services/accountFallback.ts | 1 | 1 | 0 |
| open-sse/services/accountSelector.ts | 1 | 1 | 0 |
| open-sse/services/accountSemaphore.ts | 1 | 1 | 0 |
| open-sse/services/adaptiveEffort.ts | 1 | 1 | 0 |
| open-sse/services/admission | 9 | 9 | 0 |
| open-sse/services/adobeFireflyAccount.ts | 1 | 1 | 0 |
| open-sse/services/adobeFireflyArp.ts | 1 | 1 | 0 |
| open-sse/services/adobeFireflyBrowserLogin.ts | 1 | 1 | 0 |
| open-sse/services/adobeFireflyCatalog.ts | 1 | 1 | 0 |
| open-sse/services/adobeFireflyClient.ts | 1 | 1 | 0 |
| open-sse/services/adobeFireflyCredentials.ts | 1 | 1 | 0 |
| open-sse/services/adobeFireflyIms.ts | 1 | 1 | 0 |
| open-sse/services/adobeFireflyModels.ts | 1 | 1 | 0 |
| open-sse/services/adobeFireflyModelSnapshot.ts | 1 | 1 | 0 |
| open-sse/services/adobeFireflyPayload.ts | 1 | 1 | 0 |
| open-sse/services/adobeFireflyPoll.ts | 1 | 1 | 0 |
| open-sse/services/adobeFireflyReferences.ts | 1 | 1 | 0 |
| open-sse/services/adobeFireflyResponses.ts | 1 | 1 | 0 |
| open-sse/services/adobeFireflySecurity.ts | 1 | 1 | 0 |
| open-sse/services/adobeFireflySession.ts | 1 | 1 | 0 |
| open-sse/services/adobeFireflyUpload.ts | 1 | 1 | 0 |
| open-sse/services/adobeFireflyUpscale.ts | 1 | 1 | 0 |
| open-sse/services/agenticPipeline.ts | 1 | 1 | 0 |
| open-sse/services/agentrouterQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/aihordeImageCatalog.ts | 1 | 1 | 0 |
| open-sse/services/alibabaFreeTier.ts | 1 | 1 | 0 |
| open-sse/services/alibabaFreeTierAllowlist.ts | 1 | 1 | 0 |
| open-sse/services/alibabaFreeTierDiscovery.ts | 1 | 1 | 0 |
| open-sse/services/alibabaFreeTierQuotaClassify.ts | 1 | 1 | 0 |
| open-sse/services/alibabaFreeTierQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/alibabaFreeTierQuotaTypes.ts | 1 | 1 | 0 |
| open-sse/services/antigravity429Engine.ts | 1 | 1 | 0 |
| open-sse/services/antigravityClientProfile.ts | 1 | 1 | 0 |
| open-sse/services/antigravityCredits.ts | 1 | 1 | 0 |
| open-sse/services/antigravityFamilyCooldown.ts | 1 | 1 | 0 |
| open-sse/services/antigravityHeaders.ts | 1 | 1 | 0 |
| open-sse/services/antigravityHeaderScrub.ts | 1 | 1 | 0 |
| open-sse/services/antigravityIdentity.ts | 1 | 1 | 0 |
| open-sse/services/antigravityProjectBootstrap.ts | 1 | 1 | 0 |
| open-sse/services/antigravityProjectPersist.ts | 1 | 1 | 0 |
| open-sse/services/antigravityProjectPersistence.ts | 1 | 1 | 0 |
| open-sse/services/antigravityQuotaFamily.ts | 1 | 1 | 0 |
| open-sse/services/antigravityVersion.ts | 1 | 1 | 0 |
| open-sse/services/apiKeyRotator.ts | 1 | 1 | 0 |
| open-sse/services/autoCombo | 34 | 34 | 0 |
| open-sse/services/autoRefreshDaemon.ts | 1 | 1 | 0 |
| open-sse/services/backgroundTaskDetector.ts | 1 | 1 | 0 |
| open-sse/services/bailianQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/batchProcessor.ts | 1 | 1 | 0 |
| open-sse/services/bedrock.ts | 1 | 1 | 0 |
| open-sse/services/bottleneckPatch.ts | 1 | 1 | 0 |
| open-sse/services/browserBackedChat | 1 | 1 | 0 |
| open-sse/services/browserBackedChat.ts | 1 | 1 | 0 |
| open-sse/services/browserPool.ts | 1 | 1 | 0 |
| open-sse/services/cache | 9 | 9 | 0 |
| open-sse/services/capacityAdapter.ts | 1 | 1 | 0 |
| open-sse/services/ccBridgeTransforms.ts | 1 | 1 | 0 |
| open-sse/services/ccOpenAiMediaBlocks.ts | 1 | 1 | 0 |
| open-sse/services/ccWireImageBuiltins.ts | 1 | 1 | 0 |
| open-sse/services/chatgptWebCodexAdmin.ts | 1 | 1 | 0 |
| open-sse/services/claudeAdaptiveThinking.ts | 1 | 1 | 0 |
| open-sse/services/claudeCodeCCH.ts | 1 | 1 | 0 |
| open-sse/services/claudeCodeCompatible.ts | 1 | 1 | 0 |
| open-sse/services/claudeCodeCompatibleBeta.ts | 1 | 1 | 0 |
| open-sse/services/claudeCodeCompatibleThinkingDisplay.ts | 1 | 1 | 0 |
| open-sse/services/claudeCodeConstraints.ts | 1 | 1 | 0 |
| open-sse/services/claudeCodeExtraRemap.ts | 1 | 1 | 0 |
| open-sse/services/claudeCodeFingerprint.ts | 1 | 1 | 0 |
| open-sse/services/claudeCodeObfuscation.ts | 1 | 1 | 0 |
| open-sse/services/claudeCodeToolRemapper.ts | 1 | 1 | 0 |
| open-sse/services/claudeHaikuConstraints.ts | 1 | 1 | 0 |
| open-sse/services/claudeLimitReset.ts | 1 | 1 | 0 |
| open-sse/services/claudeLowPriority.ts | 1 | 1 | 0 |
| open-sse/services/claudeTlsClient.ts | 1 | 1 | 0 |
| open-sse/services/claudeTurnstileSolver.ts | 1 | 1 | 0 |
| open-sse/services/claudeUsageCooldown.ts | 1 | 1 | 0 |
| open-sse/services/claudeWebAutoRefresh.ts | 1 | 1 | 0 |
| open-sse/services/clinepassModels.ts | 1 | 1 | 0 |
| open-sse/services/cloudCodeHeaders.ts | 1 | 1 | 0 |
| open-sse/services/cloudCodeThinking.ts | 1 | 1 | 0 |
| open-sse/services/codeAssistSubscription.ts | 1 | 1 | 0 |
| open-sse/services/codexAccount | 5 | 5 | 0 |
| open-sse/services/codexQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/codexUsageQuotas.ts | 1 | 1 | 0 |
| open-sse/services/codexVerbosity.ts | 1 | 1 | 0 |
| open-sse/services/combo | 66 | 66 | 0 |
| open-sse/services/combo.ts | 1 | 1 | 0 |
| open-sse/services/comboAgentMiddleware.ts | 1 | 1 | 0 |
| open-sse/services/comboConfig.ts | 1 | 1 | 0 |
| open-sse/services/comboContextLimit.ts | 1 | 1 | 0 |
| open-sse/services/comboMetrics.ts | 1 | 1 | 0 |
| open-sse/services/compatibleModelIdentity.ts | 1 | 1 | 0 |
| open-sse/services/compression | 146 | 146 | 0 |
| open-sse/services/connectionCircuitBreaker.ts | 1 | 1 | 0 |
| open-sse/services/conolAuth.ts | 1 | 1 | 0 |
| open-sse/services/conolBrowserLogin.ts | 1 | 1 | 0 |
| open-sse/services/conolModels.ts | 1 | 1 | 0 |
| open-sse/services/conolSessionModel.ts | 1 | 1 | 0 |
| open-sse/services/conolUsage.ts | 1 | 1 | 0 |
| open-sse/services/context7QuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/contextHandoff.ts | 1 | 1 | 0 |
| open-sse/services/contextManager.ts | 1 | 1 | 0 |
| open-sse/services/conversationTracker.ts | 1 | 1 | 0 |
| open-sse/services/conversationTurnContent.ts | 1 | 1 | 0 |
| open-sse/services/credentialGate.ts | 1 | 1 | 0 |
| open-sse/services/crofUsageFetcher.ts | 1 | 1 | 0 |
| open-sse/services/cursorApiKeyAuth.ts | 1 | 1 | 0 |
| open-sse/services/cursorSessionManager.ts | 1 | 1 | 0 |
| open-sse/services/dailyQuotaReset.ts | 1 | 1 | 0 |
| open-sse/services/dashscopeTextModels.ts | 1 | 1 | 0 |
| open-sse/services/deepseekQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/defaultReasoningEffort.ts | 1 | 1 | 0 |
| open-sse/services/deviceTracker.ts | 1 | 1 | 0 |
| open-sse/services/emergencyFallback.ts | 1 | 1 | 0 |
| open-sse/services/errorClassifier.ts | 1 | 1 | 0 |
| open-sse/services/evalRouting.ts | 1 | 1 | 0 |
| open-sse/services/firecrawlQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/freeModelQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/freeWebSearch.ts | 1 | 1 | 0 |
| open-sse/services/fusion.ts | 1 | 1 | 0 |
| open-sse/services/geminiRateLimitTracker.ts | 1 | 1 | 0 |
| open-sse/services/geminiThoughtSignatureStore.ts | 1 | 1 | 0 |
| open-sse/services/genericQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/gigachatAuth.ts | 1 | 1 | 0 |
| open-sse/services/githubCopilotModels.ts | 1 | 1 | 0 |
| open-sse/services/gpt5SamplingGuard.ts | 1 | 1 | 0 |
| open-sse/services/grokClearance.ts | 1 | 1 | 0 |
| open-sse/services/grokCliQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/grokCliQuotaFrame.ts | 1 | 1 | 0 |
| open-sse/services/grokQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/grokResetCredits.ts | 1 | 1 | 0 |
| open-sse/services/grokResetCreditsFrame.ts | 1 | 1 | 0 |
| open-sse/services/grokTlsClient.ts | 1 | 1 | 0 |
| open-sse/services/hfModelSuggestions.ts | 1 | 1 | 0 |
| open-sse/services/httpBackedChatFingerprint.ts | 1 | 1 | 0 |
| open-sse/services/hyperagentModels.ts | 1 | 1 | 0 |
| open-sse/services/iflowSignature.ts | 1 | 1 | 0 |
| open-sse/services/imageCombo.ts | 1 | 1 | 0 |
| open-sse/services/inAppLoginService.ts | 1 | 1 | 0 |
| open-sse/services/intentClassifier.ts | 1 | 1 | 0 |
| open-sse/services/ipFilter.ts | 1 | 1 | 0 |
| open-sse/services/keyGroupAuth.ts | 1 | 1 | 0 |
| open-sse/services/kiroExternalIdp.ts | 1 | 1 | 0 |
| open-sse/services/kiroModels.ts | 1 | 1 | 0 |
| open-sse/services/kiroRegion.ts | 1 | 1 | 0 |
| open-sse/services/learnedReasoningEffortCaps.ts | 1 | 1 | 0 |
| open-sse/services/learnedThinkingCaps.ts | 1 | 1 | 0 |
| open-sse/services/llmgatewayQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/lmarenaTlsClient.ts | 1 | 1 | 0 |
| open-sse/services/lyceumQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/manifestAdapter.ts | 1 | 1 | 0 |
| open-sse/services/maxaiModels.ts | 1 | 1 | 0 |
| open-sse/services/mimoThinking.ts | 1 | 1 | 0 |
| open-sse/services/model.ts | 1 | 1 | 0 |
| open-sse/services/modelAccessDenied.ts | 1 | 1 | 0 |
| open-sse/services/modelActivationIdentity.ts | 1 | 1 | 0 |
| open-sse/services/modelCapabilities.ts | 1 | 1 | 0 |
| open-sse/services/modelDeprecation.ts | 1 | 1 | 0 |
| open-sse/services/modelEndpointPolicy.ts | 1 | 1 | 0 |
| open-sse/services/modelFamilyFallback.ts | 1 | 1 | 0 |
| open-sse/services/modelLifecycle.ts | 1 | 1 | 0 |
| open-sse/services/modelscopePolicy.ts | 1 | 1 | 0 |
| open-sse/services/modelStrip.ts | 1 | 1 | 0 |
| open-sse/services/moonshotQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/museCodeAuth.ts | 1 | 1 | 0 |
| open-sse/services/newApiAggregatorQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/notionStreamParser.ts | 1 | 1 | 0 |
| open-sse/services/notionThreadSessions.ts | 1 | 1 | 0 |
| open-sse/services/notionTlsClient.ts | 1 | 1 | 0 |
| open-sse/services/notionTranscriptBuilder.ts | 1 | 1 | 0 |
| open-sse/services/notionWebFallbackModels.ts | 1 | 1 | 0 |
| open-sse/services/notionWebModels.ts | 1 | 1 | 0 |
| open-sse/services/oauthSessionOccupancy.ts | 1 | 1 | 0 |
| open-sse/services/obscura.ts | 1 | 1 | 0 |
| open-sse/services/opencodeFreeTierSkip.ts | 1 | 1 | 0 |
| open-sse/services/opencodeOllamaUsage.ts | 1 | 1 | 0 |
| open-sse/services/opencodeQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/opencodeReasoningSanitizer.ts | 1 | 1 | 0 |
| open-sse/services/openrouterFreeWindow.ts | 1 | 1 | 0 |
| open-sse/services/openrouterQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/passthroughRegistry.ts | 1 | 1 | 0 |
| open-sse/services/payloadRules.ts | 1 | 1 | 0 |
| open-sse/services/perplexityTlsClient.ts | 1 | 1 | 0 |
| open-sse/services/pipeline.ts | 1 | 1 | 0 |
| open-sse/services/promptql | 1 | 1 | 0 |
| open-sse/services/promptqlModels.ts | 1 | 1 | 0 |
| open-sse/services/provider.ts | 1 | 1 | 0 |
| open-sse/services/providerAdapters.ts | 1 | 1 | 0 |
| open-sse/services/providerAlias.ts | 1 | 1 | 0 |
| open-sse/services/providerCooldownTracker.ts | 1 | 1 | 0 |
| open-sse/services/providerCostData.ts | 1 | 1 | 0 |
| open-sse/services/providerDefaultRateLimit.ts | 1 | 1 | 0 |
| open-sse/services/providerHealth.ts | 1 | 1 | 0 |
| open-sse/services/providerRequestDefaults.ts | 1 | 1 | 0 |
| open-sse/services/proxyAutoSelector.ts | 1 | 1 | 0 |
| open-sse/services/qoderCli.ts | 1 | 1 | 0 |
| open-sse/services/qoderCliResolve.ts | 1 | 1 | 0 |
| open-sse/services/qoderCnAttachments.ts | 1 | 1 | 0 |
| open-sse/services/qoderCnCosy.ts | 1 | 1 | 0 |
| open-sse/services/qoderCnEncoding.ts | 1 | 1 | 0 |
| open-sse/services/qoderCnHttpError.ts | 1 | 1 | 0 |
| open-sse/services/qoderCnModels.ts | 1 | 1 | 0 |
| open-sse/services/qoderCnPat.ts | 1 | 1 | 0 |
| open-sse/services/qoderCnQuota.ts | 1 | 1 | 0 |
| open-sse/services/qoderCnRequest.ts | 1 | 1 | 0 |
| open-sse/services/qoderCnSse.ts | 1 | 1 | 0 |
| open-sse/services/quotaFetchThrottle.ts | 1 | 1 | 0 |
| open-sse/services/quotaMonitor.ts | 1 | 1 | 0 |
| open-sse/services/quotaPreflight.ts | 1 | 1 | 0 |
| open-sse/services/quotaResetParsing.ts | 1 | 1 | 0 |
| open-sse/services/quotaTextCooldowns.ts | 1 | 1 | 0 |
| open-sse/services/quotaTrackersBatch.ts | 1 | 1 | 0 |
| open-sse/services/quotaWindowLabel.ts | 1 | 1 | 0 |
| open-sse/services/qwenThinking.ts | 1 | 1 | 0 |
| open-sse/services/qwenTokenPlanQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/rateLimitManager | 7 | 7 | 0 |
| open-sse/services/rateLimitManager.ts | 1 | 1 | 0 |
| open-sse/services/rateLimitSemaphore.ts | 1 | 1 | 0 |
| open-sse/services/reasoningCache.ts | 1 | 1 | 0 |
| open-sse/services/reasoningInputPolicy.ts | 1 | 1 | 0 |
| open-sse/services/reasoningTokenBuffer.ts | 1 | 1 | 0 |
| open-sse/services/refreshSerializer.ts | 1 | 1 | 0 |
| open-sse/services/requestDedup.ts | 1 | 1 | 0 |
| open-sse/services/requestRejectedStreak.ts | 1 | 1 | 0 |
| open-sse/services/requestResourceErrors.ts | 1 | 1 | 0 |
| open-sse/services/requestTokenReservation.ts | 1 | 1 | 0 |
| open-sse/services/responseModelEcho.ts | 1 | 1 | 0 |
| open-sse/services/responsesInputSanitizer.ts | 1 | 1 | 0 |
| open-sse/services/responsesItemId.ts | 1 | 1 | 0 |
| open-sse/services/retryAfterJson.ts | 1 | 1 | 0 |
| open-sse/services/roleNormalizer.ts | 1 | 1 | 0 |
| open-sse/services/rollingRpmGate.ts | 1 | 1 | 0 |
| open-sse/services/rotationAttribution.ts | 1 | 1 | 0 |
| open-sse/services/rotationConfig.ts | 1 | 1 | 0 |
| open-sse/services/routing | 4 | 4 | 0 |
| open-sse/services/routingStrategies.ts | 1 | 1 | 0 |
| open-sse/services/searchCache.ts | 1 | 1 | 0 |
| open-sse/services/selfHostedEntry.ts | 1 | 1 | 0 |
| open-sse/services/sessionManager.ts | 1 | 1 | 0 |
| open-sse/services/sessionPool | 8 | 8 | 0 |
| open-sse/services/signatureCache.ts | 1 | 1 | 0 |
| open-sse/services/slidingWindowLimiter.ts | 1 | 1 | 0 |
| open-sse/services/specificityDetector.ts | 1 | 1 | 0 |
| open-sse/services/specificityRules.ts | 1 | 1 | 0 |
| open-sse/services/specificityTypes.ts | 1 | 1 | 0 |
| open-sse/services/speechCombo.ts | 1 | 1 | 0 |
| open-sse/services/streamRecovery.ts | 1 | 1 | 0 |
| open-sse/services/systemPrompt.ts | 1 | 1 | 0 |
| open-sse/services/systemTransforms.ts | 1 | 1 | 0 |
| open-sse/services/targetRequestSanitizer.ts | 1 | 1 | 0 |
| open-sse/services/taskAwareRouter.ts | 1 | 1 | 0 |
| open-sse/services/taskAwareRouting.ts | 1 | 1 | 0 |
| open-sse/services/tavilyQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/thinkingBudget.ts | 1 | 1 | 0 |
| open-sse/services/throughputWatchdog.ts | 1 | 1 | 0 |
| open-sse/services/tierConfig.ts | 1 | 1 | 0 |
| open-sse/services/tierResolver.ts | 1 | 1 | 0 |
| open-sse/services/tierTypes.ts | 1 | 1 | 0 |
| open-sse/services/tlsClientBase.ts | 1 | 1 | 0 |
| open-sse/services/tlsClientProxy.ts | 1 | 1 | 0 |
| open-sse/services/tokenExtractionConfig.ts | 1 | 1 | 0 |
| open-sse/services/tokenLimitCounter.ts | 1 | 1 | 0 |
| open-sse/services/tokenRefresh | 20 | 20 | 0 |
| open-sse/services/tokenRefresh.ts | 1 | 1 | 0 |
| open-sse/services/toolLatencyTracker.ts | 1 | 1 | 0 |
| open-sse/services/toolLimitDetector.ts | 1 | 1 | 0 |
| open-sse/services/toolSchemaSanitizer.ts | 1 | 1 | 0 |
| open-sse/services/transientBackendRetry.ts | 1 | 1 | 0 |
| open-sse/services/usage | 46 | 46 | 0 |
| open-sse/services/usage.ts | 1 | 1 | 0 |
| open-sse/services/v0QuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/videoCombo.ts | 1 | 1 | 0 |
| open-sse/services/volcengineConsoleAutoLogin.ts | 1 | 1 | 0 |
| open-sse/services/volumeDetector.ts | 1 | 1 | 0 |
| open-sse/services/wafRateLimit.ts | 1 | 1 | 0 |
| open-sse/services/webFetchInterception.ts | 1 | 1 | 0 |
| open-sse/services/webSearchFallback.ts | 1 | 1 | 0 |
| open-sse/services/webSearchRouting.ts | 1 | 1 | 0 |
| open-sse/services/webSessionPoolHealth.ts | 1 | 1 | 0 |
| open-sse/services/wildcardRouter.ts | 1 | 1 | 0 |
| open-sse/services/workflowFSM.ts | 1 | 1 | 0 |
| open-sse/services/xaiMessageCap.ts | 1 | 1 | 0 |
| open-sse/services/xaiOauthQuotaFetcher.ts | 1 | 1 | 0 |
| open-sse/services/zaiWebCredentials.ts | 1 | 1 | 0 |
| open-sse/shared/zedAuth.ts | 1 | 0 | 1 |
| open-sse/transformer/responsesTransformer.ts | 1 | 1 | 0 |
| open-sse/translator/bootstrap.ts | 1 | 1 | 0 |
| open-sse/translator/concerns | 2 | 2 | 0 |
| open-sse/translator/deepseekWebTools.ts | 1 | 1 | 0 |
| open-sse/translator/formats.ts | 1 | 1 | 0 |
| open-sse/translator/helpers | 14 | 14 | 0 |
| open-sse/translator/image | 1 | 1 | 0 |
| open-sse/translator/index.ts | 1 | 1 | 0 |
| open-sse/translator/paramSupport.ts | 1 | 1 | 0 |
| open-sse/translator/registry.ts | 1 | 1 | 0 |
| open-sse/translator/request | 22 | 22 | 0 |
| open-sse/translator/response | 21 | 21 | 0 |
| open-sse/translator/webTools.ts | 1 | 1 | 0 |
| open-sse/utils/agentGoalPolicy.ts | 1 | 0 | 1 |
| open-sse/utils/aiSdkCompat.ts | 1 | 0 | 1 |
| open-sse/utils/anthropicHost.ts | 1 | 0 | 1 |
| open-sse/utils/audioResponse.ts | 1 | 0 | 1 |
| open-sse/utils/awsSigV4.ts | 1 | 0 | 1 |
| open-sse/utils/bypassHandler.ts | 1 | 0 | 1 |
| open-sse/utils/bypassResponse.ts | 1 | 0 | 1 |
| open-sse/utils/cacheControlPolicy.ts | 1 | 0 | 1 |
| open-sse/utils/ccDiscoveryAliases.ts | 1 | 0 | 1 |
| open-sse/utils/chatgptWebAttachments.ts | 1 | 0 | 1 |
| open-sse/utils/chatgptWebBrowserSession.ts | 1 | 0 | 1 |
| open-sse/utils/chatgptWebDeltaV1.ts | 1 | 0 | 1 |
| open-sse/utils/chatgptWebExecutorAdapter.ts | 1 | 0 | 1 |
| open-sse/utils/chatgptWebFirstParty.ts | 1 | 0 | 1 |
| open-sse/utils/chatgptWebTransport.ts | 1 | 0 | 1 |
| open-sse/utils/claudeCodeMetaRequests.ts | 1 | 0 | 1 |
| open-sse/utils/claudeEffortVariants.ts | 1 | 0 | 1 |
| open-sse/utils/clinepassEnvelope.ts | 1 | 0 | 1 |
| open-sse/utils/codexPublicError.ts | 1 | 0 | 1 |
| open-sse/utils/comfyuiClient.ts | 1 | 0 | 1 |
| open-sse/utils/composerToolCalls.ts | 1 | 0 | 1 |
| open-sse/utils/cookieDomain.ts | 1 | 0 | 1 |
| open-sse/utils/cors.ts | 1 | 0 | 1 |
| open-sse/utils/credentialPatterns.ts | 1 | 0 | 1 |
| open-sse/utils/cursorAgentCliVersion.ts | 1 | 0 | 1 |
| open-sse/utils/cursorAgentCliVersionPin.ts | 1 | 0 | 1 |
| open-sse/utils/cursorAgentProtobuf | 9 | 0 | 9 |
| open-sse/utils/cursorAgentProtobuf.ts | 1 | 0 | 1 |
| open-sse/utils/cursorChecksum.ts | 1 | 0 | 1 |
| open-sse/utils/cursorImages.ts | 1 | 0 | 1 |
| open-sse/utils/cursorVersionDetector.ts | 1 | 0 | 1 |
| open-sse/utils/devinLiteralModelIds.ts | 1 | 0 | 1 |
| open-sse/utils/diagnostics.ts | 1 | 0 | 1 |
| open-sse/utils/directivePreambleStripper.ts | 1 | 0 | 1 |
| open-sse/utils/directResponseStartTimeout.ts | 1 | 0 | 1 |
| open-sse/utils/dsmlToolCalls.ts | 1 | 0 | 1 |
| open-sse/utils/earlyKeepaliveByteBuffer.ts | 1 | 0 | 1 |
| open-sse/utils/earlyStreamKeepalive.ts | 1 | 0 | 1 |
| open-sse/utils/emptyTurnRetry.ts | 1 | 0 | 1 |
| open-sse/utils/error.ts | 1 | 0 | 1 |
| open-sse/utils/errorPathRedaction.ts | 1 | 0 | 1 |
| open-sse/utils/errorSanitization.ts | 1 | 0 | 1 |
| open-sse/utils/estimateSize.ts | 1 | 0 | 1 |
| open-sse/utils/fetchStartTimeoutPolicy.ts | 1 | 0 | 1 |
| open-sse/utils/finishReason.ts | 1 | 0 | 1 |
| open-sse/utils/firstByteWatchdog.ts | 1 | 0 | 1 |
| open-sse/utils/flattenToolHistory.ts | 1 | 0 | 1 |
| open-sse/utils/functionalGatewayMirrors.ts | 1 | 0 | 1 |
| open-sse/utils/geminiCookies.ts | 1 | 0 | 1 |
| open-sse/utils/generationThroughput.ts | 1 | 0 | 1 |
| open-sse/utils/headers.ts | 1 | 0 | 1 |
| open-sse/utils/heapPressure.ts | 1 | 0 | 1 |
| open-sse/utils/imageNormalize.ts | 1 | 0 | 1 |
| open-sse/utils/jsonHash.ts | 1 | 0 | 1 |
| open-sse/utils/jsonSize.ts | 1 | 0 | 1 |
| open-sse/utils/jsonToSse.ts | 1 | 0 | 1 |
| open-sse/utils/keepaliveThreshold.ts | 1 | 0 | 1 |
| open-sse/utils/kieTask.ts | 1 | 0 | 1 |
| open-sse/utils/kimiDevice.ts | 1 | 0 | 1 |
| open-sse/utils/kimiJwt.ts | 1 | 0 | 1 |
| open-sse/utils/kimiToolCallNarration.ts | 1 | 0 | 1 |
| open-sse/utils/kiroSanitizer.ts | 1 | 0 | 1 |
| open-sse/utils/logger.ts | 1 | 0 | 1 |
| open-sse/utils/mediaParts.ts | 1 | 0 | 1 |
| open-sse/utils/modelIdSafety.ts | 1 | 0 | 1 |
| open-sse/utils/networkProxy.ts | 1 | 0 | 1 |
| open-sse/utils/nextAuthCookie.ts | 1 | 0 | 1 |
| open-sse/utils/noThinkingAlias.ts | 1 | 0 | 1 |
| open-sse/utils/number.ts | 1 | 0 | 1 |
| open-sse/utils/ollamaTransform.ts | 1 | 0 | 1 |
| open-sse/utils/openAIStreamChunk.ts | 1 | 0 | 1 |
| open-sse/utils/opencodeHeaders.ts | 1 | 0 | 1 |
| open-sse/utils/opencodeSessionIdentity.ts | 1 | 0 | 1 |
| open-sse/utils/optionalPacks.ts | 1 | 0 | 1 |
| open-sse/utils/passthroughTailProcessor.ts | 1 | 0 | 1 |
| open-sse/utils/pendingRequestCleanup.ts | 1 | 0 | 1 |
| open-sse/utils/pickCacheCreationTokens.ts | 1 | 0 | 1 |
| open-sse/utils/progressTracker.ts | 1 | 0 | 1 |
| open-sse/utils/providerRequestLogging.ts | 1 | 0 | 1 |
| open-sse/utils/proxyDispatcher.ts | 1 | 0 | 1 |
| open-sse/utils/proxyDispatcherCache.ts | 1 | 0 | 1 |
| open-sse/utils/proxyFallback.ts | 1 | 0 | 1 |
| open-sse/utils/proxyFamily.ts | 1 | 0 | 1 |
| open-sse/utils/proxyFamilyResolve.ts | 1 | 0 | 1 |
| open-sse/utils/proxyFetch.ts | 1 | 0 | 1 |
| open-sse/utils/proxyFetchRedaction.ts | 1 | 0 | 1 |
| open-sse/utils/proxyRefusalMemory.ts | 1 | 0 | 1 |
| open-sse/utils/proxyTransitionListeners.ts | 1 | 0 | 1 |
| open-sse/utils/proxyTransportError.ts | 1 | 0 | 1 |
| open-sse/utils/proxyTransportOutcome.ts | 1 | 0 | 1 |
| open-sse/utils/publicCreds.ts | 1 | 0 | 1 |
| open-sse/utils/reasoningContentInjector.ts | 1 | 0 | 1 |
| open-sse/utils/reasoningFields.ts | 1 | 0 | 1 |
| open-sse/utils/reasoningPlaceholder.ts | 1 | 0 | 1 |
| open-sse/utils/reasoningRuleContext.ts | 1 | 0 | 1 |
| open-sse/utils/registeredEffortVariants.ts | 1 | 0 | 1 |
| open-sse/utils/requestLogger.ts | 1 | 0 | 1 |
| open-sse/utils/resolveResponsesCacheUsageDetails.ts | 1 | 0 | 1 |
| open-sse/utils/resourcePressure.ts | 1 | 0 | 1 |
| open-sse/utils/resourcePressurePolicy.ts | 1 | 0 | 1 |
| open-sse/utils/resourcePressureSampler.ts | 1 | 0 | 1 |
| open-sse/utils/responsesCommentaryDrop.ts | 1 | 0 | 1 |
| open-sse/utils/responsesEndpoint.ts | 1 | 0 | 1 |
| open-sse/utils/responsesFailureOutput.ts | 1 | 0 | 1 |
| open-sse/utils/responsesInputNormalization.ts | 1 | 0 | 1 |
| open-sse/utils/responsesReasoningObservation.ts | 1 | 0 | 1 |
| open-sse/utils/responsesSequence.ts | 1 | 0 | 1 |
| open-sse/utils/responsesStatePolicy.ts | 1 | 0 | 1 |
| open-sse/utils/responsesStreamHelpers.ts | 1 | 0 | 1 |
| open-sse/utils/responsesToolHandoff.ts | 1 | 0 | 1 |
| open-sse/utils/retryAfterInstant.ts | 1 | 0 | 1 |
| open-sse/utils/secureFileWrite.ts | 1 | 0 | 1 |
| open-sse/utils/segmindClient.ts | 1 | 0 | 1 |
| open-sse/utils/selfHop.ts | 1 | 0 | 1 |
| open-sse/utils/setupPolyfill.ts | 1 | 0 | 1 |
| open-sse/utils/sleep.ts | 1 | 0 | 1 |
| open-sse/utils/socksConnectorWithFamily.ts | 1 | 0 | 1 |
| open-sse/utils/sseHeartbeat.ts | 1 | 0 | 1 |
| open-sse/utils/sseOutputSignal.ts | 1 | 0 | 1 |
| open-sse/utils/stream.ts | 1 | 0 | 1 |
| open-sse/utils/streamClaudeDelta.ts | 1 | 0 | 1 |
| open-sse/utils/streamClaudeEmptyBody.ts | 1 | 0 | 1 |
| open-sse/utils/streamDeadlineSignal.ts | 1 | 0 | 1 |
| open-sse/utils/streamEmptyChoices.ts | 1 | 0 | 1 |
| open-sse/utils/streamErrorFormat.ts | 1 | 0 | 1 |
| open-sse/utils/streamFailureBoundary.ts | 1 | 0 | 1 |
| open-sse/utils/streamFailureFinalization.ts | 1 | 0 | 1 |
| open-sse/utils/streamHandler.ts | 1 | 0 | 1 |
| open-sse/utils/streamHelpers.ts | 1 | 0 | 1 |
| open-sse/utils/streamPayloadCollector.ts | 1 | 0 | 1 |
| open-sse/utils/streamReadiness.ts | 1 | 0 | 1 |
| open-sse/utils/streamReadinessPolicy.ts | 1 | 0 | 1 |
| open-sse/utils/streamTerminal.ts | 1 | 0 | 1 |
| open-sse/utils/streamTiming.ts | 1 | 0 | 1 |
| open-sse/utils/syncedEffortVariants.ts | 1 | 0 | 1 |
| open-sse/utils/tagBlocks.ts | 1 | 0 | 1 |
| open-sse/utils/textualToolCall.ts | 1 | 0 | 1 |
| open-sse/utils/thinkCloseMarker.ts | 1 | 0 | 1 |
| open-sse/utils/thinkingBudget.ts | 1 | 0 | 1 |
| open-sse/utils/thinkTagParser.ts | 1 | 0 | 1 |
| open-sse/utils/timingMs.ts | 1 | 0 | 1 |
| open-sse/utils/tlsClient.ts | 1 | 0 | 1 |
| open-sse/utils/tlsFirstByteWatchdog.ts | 1 | 0 | 1 |
| open-sse/utils/tokenExpiry.ts | 1 | 0 | 1 |
| open-sse/utils/toolCallArguments.ts | 1 | 0 | 1 |
| open-sse/utils/toolSources.ts | 1 | 0 | 1 |
| open-sse/utils/traeHost.ts | 1 | 0 | 1 |
| open-sse/utils/upstreamErrorPassthrough.ts | 1 | 0 | 1 |
| open-sse/utils/upstreamErrorResponse.ts | 1 | 0 | 1 |
| open-sse/utils/upstreamResponseHeaders.ts | 1 | 0 | 1 |
| open-sse/utils/upstreamStatusCapture.ts | 1 | 0 | 1 |
| open-sse/utils/urlSanitize.ts | 1 | 0 | 1 |
| open-sse/utils/usageOnlyChunk.ts | 1 | 0 | 1 |
| open-sse/utils/usageTracking.ts | 1 | 0 | 1 |
| open-sse/utils/zeroWidth.ts | 1 | 0 | 1 |
| open-sse/vendor/codex-chatgpt-web | 46 | 0 | 46 |
| packages/browser-pool/src | 5 | 0 | 5 |
| scripts/ad-hoc/providerInventoryParse.mjs | 1 | 1 | 0 |
| scripts/build/assembleStandalone.mjs | 1 | 0 | 1 |
| scripts/build/backendOnlyPages.mjs | 1 | 0 | 1 |
| scripts/build/better-sqlite3-stub-flag.mjs | 1 | 0 | 1 |
| scripts/build/betterSqlitePrebuildTarget.mjs | 1 | 0 | 1 |
| scripts/build/bootstrap-env.mjs | 1 | 0 | 1 |
| scripts/build/build-next-isolated.mjs | 1 | 0 | 1 |
| scripts/build/build-tproxy-native.mjs | 1 | 0 | 1 |
| scripts/build/buildProvenance.ts | 1 | 0 | 1 |
| scripts/build/buildToolRunner.mjs | 1 | 0 | 1 |
| scripts/build/clean-build-output.mjs | 1 | 0 | 1 |
| scripts/build/colocate-standalone.mjs | 1 | 0 | 1 |
| scripts/build/colocateOptionals.mjs | 1 | 0 | 1 |
| scripts/build/dashboardEmbed.mjs | 1 | 0 | 1 |
| scripts/build/electronRebuildPlan.mjs | 1 | 0 | 1 |
| scripts/build/electronRuntimeDocs.mjs | 1 | 0 | 1 |
| scripts/build/hydrateNativeDeps.mjs | 1 | 0 | 1 |
| scripts/build/mcpPublishedFilesClosure.ts | 1 | 0 | 1 |
| scripts/build/mitm-stub-flag.mjs | 1 | 0 | 1 |
| scripts/build/native-binary-compat.mjs | 1 | 0 | 1 |
| scripts/build/normalizeBasePath.mjs | 1 | 0 | 1 |
| scripts/build/optionalPackStaging.mjs | 1 | 0 | 1 |
| scripts/build/pack-artifact-policy.ts | 1 | 0 | 1 |
| scripts/build/postinstallSupport.mjs | 1 | 0 | 1 |
| scripts/build/resolveNpmEntry.ts | 1 | 0 | 1 |
| scripts/build/resolveWorkspaceProtocols.ts | 1 | 0 | 1 |
| scripts/build/runtime-env.mjs | 1 | 0 | 1 |
| scripts/build/standaloneBundle.mjs | 1 | 0 | 1 |
| scripts/build/standaloneManifest.mjs | 1 | 0 | 1 |
| scripts/build/standaloneTarball.mjs | 1 | 0 | 1 |
| scripts/build/wreqJsNative.mjs | 1 | 0 | 1 |
| scripts/check/check-ai-attribution.mjs | 1 | 0 | 1 |
| scripts/check/check-api-typecheck.mjs | 1 | 0 | 1 |
| scripts/check/check-bundle-size.mjs | 1 | 0 | 1 |
| scripts/check/check-changelog-integrity.mjs | 1 | 0 | 1 |
| scripts/check/check-circular-deps.mjs | 1 | 0 | 1 |
| scripts/check/check-cli-fingerprint-drift.ts | 1 | 0 | 1 |
| scripts/check/check-codeql-ratchet.mjs | 1 | 0 | 1 |
| scripts/check/check-cognitive-complexity.mjs | 1 | 0 | 1 |
| scripts/check/check-complexity.mjs | 1 | 0 | 1 |
| scripts/check/check-dashboard-typecheck.mjs | 1 | 0 | 1 |
| scripts/check/check-db-rules.mjs | 1 | 0 | 1 |
| scripts/check/check-dead-code.mjs | 1 | 0 | 1 |
| scripts/check/check-deps.mjs | 1 | 0 | 1 |
| scripts/check/check-docs-counts-sync.mjs | 1 | 0 | 1 |
| scripts/check/check-docs-symbols.mjs | 1 | 0 | 1 |
| scripts/check/check-duplication.mjs | 1 | 0 | 1 |
| scripts/check/check-env-doc-sync.mjs | 1 | 0 | 1 |
| scripts/check/check-error-helper.mjs | 1 | 0 | 1 |
| scripts/check/check-fabricated-docs.mjs | 1 | 0 | 1 |
| scripts/check/check-fetch-targets.mjs | 1 | 0 | 1 |
| scripts/check/check-file-size.mjs | 1 | 0 | 1 |
| scripts/check/check-forgotten-sibling-tests.mjs | 1 | 0 | 1 |
| scripts/check/check-install-upgrade.mjs | 1 | 0 | 1 |
| scripts/check/check-known-symbols.ts | 1 | 0 | 1 |
| scripts/check/check-licenses.mjs | 1 | 0 | 1 |
| scripts/check/check-lockfile.mjs | 1 | 0 | 1 |
| scripts/check/check-migration-numbering.mjs | 1 | 0 | 1 |
| scripts/check/check-model-lifecycle.mjs | 1 | 0 | 1 |
| scripts/check/check-mutation-ratchet.mjs | 1 | 0 | 1 |
| scripts/check/check-mutation-test-coverage.mjs | 1 | 0 | 1 |
| scripts/check/check-native-deps.mjs | 1 | 0 | 1 |
| scripts/check/check-nvidia-catalog-drift.ts | 1 | 0 | 1 |
| scripts/check/check-open-sse-typecheck.mjs | 1 | 0 | 1 |
| scripts/check/check-openapi-breaking.mjs | 1 | 0 | 1 |
| scripts/check/check-openapi-routes.mjs | 1 | 0 | 1 |
| scripts/check/check-pack-boot.mjs | 1 | 0 | 1 |
| scripts/check/check-pr-evidence.mjs | 1 | 0 | 1 |
| scripts/check/check-pr-self-target.mjs | 1 | 0 | 1 |
| scripts/check/check-provider-consistency.ts | 1 | 0 | 1 |
| scripts/check/check-public-creds.mjs | 1 | 0 | 1 |
| scripts/check/check-route-guard-membership.ts | 1 | 0 | 1 |
| scripts/check/check-routing-error-guard.mjs | 1 | 0 | 1 |
| scripts/check/check-rtl-ratchet.mjs | 1 | 0 | 1 |
| scripts/check/check-secrets.mjs | 1 | 0 | 1 |
| scripts/check/check-test-discovery.mjs | 1 | 0 | 1 |
| scripts/check/check-test-masking.mjs | 1 | 0 | 1 |
| scripts/check/check-test-runner-api.mjs | 1 | 0 | 1 |
| scripts/check/check-tracked-artifacts.mjs | 1 | 0 | 1 |
| scripts/check/check-ts7-diagnostics-ratchet.mjs | 1 | 0 | 1 |
| scripts/check/check-type-coverage.mjs | 1 | 0 | 1 |
| scripts/check/check-vitest-exclusions.mjs | 1 | 0 | 1 |
| scripts/check/check-vuln-ratchet.mjs | 1 | 0 | 1 |
| scripts/check/check-workflows.mjs | 1 | 0 | 1 |
| scripts/check/complexityEslintReport.mjs | 1 | 0 | 1 |
| scripts/check/lib | 4 | 0 | 4 |
| scripts/check/newCodeMode.mjs | 1 | 0 | 1 |
| scripts/check/typecheckBaseline.mjs | 1 | 0 | 1 |
| scripts/ci/check-published-boot.mjs | 1 | 0 | 1 |
| scripts/cli/smoke-cli-integrations.mjs | 1 | 0 | 1 |
| scripts/cli/smoke-safety.mjs | 1 | 0 | 1 |
| scripts/dev/brand-sweep.mjs | 1 | 0 | 1 |
| scripts/dev/ensure-native-sqlite.mjs | 1 | 0 | 1 |
| scripts/dev/gen-primitive-icons.mjs | 1 | 0 | 1 |
| scripts/dev/head-response-guard.cjs | 1 | 0 | 1 |
| scripts/dev/healthcheck.mjs | 1 | 0 | 1 |
| scripts/dev/http-method-guard.cjs | 1 | 0 | 1 |
| scripts/dev/httpClientAbortGuard.mjs | 1 | 0 | 1 |
| scripts/dev/links-codemod.mjs | 1 | 0 | 1 |
| scripts/dev/main-server-timeouts.mjs | 1 | 0 | 1 |
| scripts/dev/peer-stamp.mjs | 1 | 0 | 1 |
| scripts/dev/responses-ws-proxy.mjs | 1 | 0 | 1 |
| scripts/dev/run-next-playwright.mjs | 1 | 0 | 1 |
| scripts/dev/smoke-electron-packaged.mjs | 1 | 0 | 1 |
| scripts/dev/sync-env.mjs | 1 | 0 | 1 |
| scripts/dev/systemd-notify.mjs | 1 | 0 | 1 |
| scripts/dev/tls-options.mjs | 1 | 0 | 1 |
| scripts/dev/turbopackCacheHeal.mjs | 1 | 0 | 1 |
| scripts/dev/v1-ws-bridge.mjs | 1 | 0 | 1 |
| scripts/dev/webdav-handler.mjs | 1 | 0 | 1 |
| scripts/devin-bridge/runtime-policy.mjs | 1 | 0 | 1 |
| scripts/devin-bridge/select-live-model.mjs | 1 | 0 | 1 |
| scripts/devin-bridge/validate-claude-evidence.mjs | 1 | 0 | 1 |
| scripts/docker/ensure-docker-base-path.mjs | 1 | 0 | 1 |
| scripts/docker/patch-standalone-base-path.mjs | 1 | 0 | 1 |
| scripts/docs/sync-wiki.mjs | 1 | 0 | 1 |
| scripts/features/feature-triage.mjs | 1 | 0 | 1 |
| scripts/features/lib | 7 | 0 | 7 |
| scripts/homolog/lib | 5 | 0 | 5 |
| scripts/ops/deployCanary.ts | 1 | 0 | 1 |
| scripts/packs/optionalPackInstaller.mjs | 1 | 0 | 1 |
| scripts/packs/optionalPackManifest.mjs | 1 | 0 | 1 |
| scripts/perf/agentPayloadCorpus.ts | 1 | 0 | 1 |
| scripts/perf/messages-route-memory-profile.ts | 1 | 0 | 1 |
| scripts/perf/video-bridge-contact-sheet-eval.ts | 1 | 0 | 1 |
| scripts/perf/video-bridge-promotion-eval.ts | 1 | 0 | 1 |
| scripts/quality/balance-e2e-shards.mjs | 1 | 0 | 1 |
| scripts/quality/baseline-headroom.mjs | 1 | 0 | 1 |
| scripts/quality/build-test-impact-map.mjs | 1 | 0 | 1 |
| scripts/quality/classify-pr-changes.mjs | 1 | 0 | 1 |
| scripts/quality/collect-metrics.mjs | 1 | 0 | 1 |
| scripts/quality/mutation-radiography.mjs | 1 | 0 | 1 |
| scripts/quality/property-seed.mjs | 1 | 0 | 1 |
| scripts/quality/release-acceptance | 6 | 0 | 6 |
| scripts/quality/select-impacted-tests.mjs | 1 | 0 | 1 |
| scripts/quality/validate-release-acceptance.mjs | 1 | 0 | 1 |
| scripts/quality/validate-release-green.mjs | 1 | 0 | 1 |
| scripts/quality/verify-ratchet-bank.mjs | 1 | 0 | 1 |
| scripts/release/aggregate-changelog.mjs | 1 | 0 | 1 |
| scripts/release/artifact.mjs | 1 | 1 | 0 |
| scripts/release/changesets.mjs | 1 | 0 | 1 |
| scripts/release/gen-contributors.mjs | 1 | 0 | 1 |
| scripts/release/list-uncovered-commits.mjs | 1 | 0 | 1 |
| scripts/release/merge-mac-update-manifest.mjs | 1 | 0 | 1 |
| scripts/release/promote-main-artifact.mjs | 1 | 0 | 1 |
| scripts/release/reconcile-changelog.mjs | 1 | 1 | 0 |
| scripts/release/refresh-cli-identities.mjs | 1 | 0 | 1 |
| scripts/release/rehome-open-prs.mjs | 1 | 1 | 0 |
| scripts/release/sweep-stale-fragments.mjs | 1 | 0 | 1 |
| scripts/release/sync-next-cycle.mjs | 1 | 0 | 1 |
| scripts/release/verify-published.mjs | 1 | 0 | 1 |
| scripts/research/update-models-dev-seed.mjs | 1 | 0 | 1 |
| scripts/sre/oncall-rotation.mjs | 1 | 0 | 1 |
| scripts/sre/redact-logs.mjs | 1 | 0 | 1 |
| scripts/start-ws-server.mjs | 1 | 0 | 1 |
| src/app/.well-known | 2 | 0 | 2 |
| src/app/(dashboard) | 159 | 2 | 157 |
| src/app/a2a | 1 | 0 | 1 |
| src/app/api/[...omnirouteApiCatchAll] | 1 | 0 | 1 |
| src/app/api/a2a | 6 | 0 | 6 |
| src/app/api/access | 1 | 0 | 1 |
| src/app/api/acp | 1 | 0 | 1 |
| src/app/api/admin | 2 | 0 | 2 |
| src/app/api/agent-skills | 5 | 0 | 5 |
| src/app/api/analytics | 3 | 0 | 3 |
| src/app/api/assess | 1 | 0 | 1 |
| src/app/api/auth | 13 | 0 | 13 |
| src/app/api/batches | 2 | 0 | 2 |
| src/app/api/branding | 1 | 0 | 1 |
| src/app/api/budgets | 4 | 0 | 4 |
| src/app/api/cache | 5 | 0 | 5 |
| src/app/api/chaos | 2 | 0 | 2 |
| src/app/api/cli | 4 | 0 | 4 |
| src/app/api/cli-tools | 33 | 0 | 33 |
| src/app/api/cloud | 4 | 0 | 4 |
| src/app/api/codex | 1 | 0 | 1 |
| src/app/api/combos | 10 | 10 | 0 |
| src/app/api/compliance | 1 | 0 | 1 |
| src/app/api/compression | 7 | 0 | 7 |
| src/app/api/conductor | 5 | 0 | 5 |
| src/app/api/context | 13 | 0 | 13 |
| src/app/api/conversations | 3 | 0 | 3 |
| src/app/api/copilot | 1 | 0 | 1 |
| src/app/api/cursor-cli | 1 | 0 | 1 |
| src/app/api/dahl | 1 | 0 | 1 |
| src/app/api/db | 1 | 0 | 1 |
| src/app/api/db-backups | 4 | 0 | 4 |
| src/app/api/discovery | 4 | 0 | 4 |
| src/app/api/docs | 2 | 0 | 2 |
| src/app/api/evals | 4 | 0 | 4 |
| src/app/api/fallback | 1 | 0 | 1 |
| src/app/api/files | 2 | 0 | 2 |
| src/app/api/free-models | 1 | 0 | 1 |
| src/app/api/free-provider-rankings | 1 | 0 | 1 |
| src/app/api/free-tier | 1 | 0 | 1 |
| src/app/api/github-skills | 1 | 0 | 1 |
| src/app/api/guardrails | 2 | 0 | 2 |
| src/app/api/headroom | 3 | 0 | 3 |
| src/app/api/health | 3 | 0 | 3 |
| src/app/api/init | 1 | 0 | 1 |
| src/app/api/intelligence | 1 | 0 | 1 |
| src/app/api/internal | 4 | 0 | 4 |
| src/app/api/issue-agent | 1 | 0 | 1 |
| src/app/api/jobs | 5 | 0 | 5 |
| src/app/api/keys | 11 | 0 | 11 |
| src/app/api/local | 5 | 0 | 5 |
| src/app/api/log-export | 6 | 0 | 6 |
| src/app/api/logs | 5 | 0 | 5 |
| src/app/api/mcp | 7 | 0 | 7 |
| src/app/api/memory | 9 | 0 | 9 |
| src/app/api/metrics | 2 | 0 | 2 |
| src/app/api/middleware | 2 | 0 | 2 |
| src/app/api/modality-bridge | 4 | 0 | 4 |
| src/app/api/model-capability-overrides | 1 | 0 | 1 |
| src/app/api/model-combo-mappings | 2 | 0 | 2 |
| src/app/api/models | 5 | 0 | 5 |
| src/app/api/monitoring | 2 | 0 | 2 |
| src/app/api/network | 1 | 0 | 1 |
| src/app/api/oauth | 24 | 24 | 0 |
| src/app/api/omniroute | 2 | 0 | 2 |
| src/app/api/openapi | 2 | 0 | 2 |
| src/app/api/playground | 5 | 0 | 5 |
| src/app/api/plugins | 8 | 0 | 8 |
| src/app/api/policies | 1 | 0 | 1 |
| src/app/api/pricing | 4 | 0 | 4 |
| src/app/api/provider-metrics | 1 | 0 | 1 |
| src/app/api/provider-models | 1 | 0 | 1 |
| src/app/api/provider-nodes | 4 | 4 | 0 |
| src/app/api/provider-stats | 1 | 0 | 1 |
| src/app/api/providers | 73 | 73 | 0 |
| src/app/api/quota | 11 | 0 | 11 |
| src/app/api/radar | 12 | 0 | 12 |
| src/app/api/rate-limit | 1 | 0 | 1 |
| src/app/api/rate-limits | 1 | 0 | 1 |
| src/app/api/relay | 2 | 0 | 2 |
| src/app/api/resilience | 4 | 0 | 4 |
| src/app/api/restart | 1 | 0 | 1 |
| src/app/api/routing | 6 | 0 | 6 |
| src/app/api/search | 2 | 0 | 2 |
| src/app/api/services | 66 | 0 | 66 |
| src/app/api/session-pools | 2 | 0 | 2 |
| src/app/api/sessions | 1 | 0 | 1 |
| src/app/api/settings | 94 | 0 | 94 |
| src/app/api/setup | 1 | 0 | 1 |
| src/app/api/shutdown | 1 | 0 | 1 |
| src/app/api/skills | 11 | 0 | 11 |
| src/app/api/storage | 1 | 0 | 1 |
| src/app/api/sync | 5 | 0 | 5 |
| src/app/api/synced-available-models | 1 | 0 | 1 |
| src/app/api/system | 4 | 0 | 4 |
| src/app/api/tags | 1 | 0 | 1 |
| src/app/api/telegram | 1 | 0 | 1 |
| src/app/api/telemetry | 1 | 0 | 1 |
| src/app/api/tenant | 5 | 0 | 5 |
| src/app/api/tenants | 13 | 0 | 13 |
| src/app/api/token-health | 1 | 0 | 1 |
| src/app/api/tools | 35 | 0 | 35 |
| src/app/api/translator | 5 | 0 | 5 |
| src/app/api/tunnels | 20 | 0 | 20 |
| src/app/api/upstream-proxy | 1 | 0 | 1 |
| src/app/api/usage | 31 | 31 | 0 |
| src/app/api/usage-sinks | 5 | 0 | 5 |
| src/app/api/v1 | 174 | 174 | 0 |
| src/app/api/v1beta | 3 | 0 | 3 |
| src/app/api/version-manager | 7 | 0 | 7 |
| src/app/api/vnc-session | 2 | 0 | 2 |
| src/app/api/webhooks | 4 | 0 | 4 |
| src/app/authorize | 3 | 0 | 3 |
| src/app/docs | 2 | 0 | 2 |
| src/app/healthz | 1 | 0 | 1 |
| src/app/livez | 1 | 0 | 1 |
| src/app/manifest.ts | 1 | 1 | 0 |
| src/app/readyz | 1 | 0 | 1 |
| src/domain/assessment | 6 | 0 | 6 |
| src/domain/budgetEngine.ts | 1 | 0 | 1 |
| src/domain/budgetWindow.ts | 1 | 1 | 0 |
| src/domain/comboResolver.ts | 1 | 0 | 1 |
| src/domain/configAudit.ts | 1 | 0 | 1 |
| src/domain/connectionModelRules.ts | 1 | 0 | 1 |
| src/domain/costRules.ts | 1 | 0 | 1 |
| src/domain/degradation.ts | 1 | 0 | 1 |
| src/domain/fallbackPolicy.ts | 1 | 0 | 1 |
| src/domain/keyQuota.ts | 1 | 0 | 1 |
| src/domain/lockoutPolicy.ts | 1 | 1 | 0 |
| src/domain/modelAvailability.ts | 1 | 0 | 1 |
| src/domain/omnirouteResponseMeta.ts | 1 | 0 | 1 |
| src/domain/persistence | 1 | 0 | 1 |
| src/domain/pipeline.ts | 1 | 0 | 1 |
| src/domain/policyEngine.ts | 1 | 0 | 1 |
| src/domain/prompts.ts | 1 | 0 | 1 |
| src/domain/providerExpiration.ts | 1 | 0 | 1 |
| src/domain/quotaCache.ts | 1 | 0 | 1 |
| src/domain/quotaCacheState.ts | 1 | 0 | 1 |
| src/domain/tagRouter.ts | 1 | 0 | 1 |
| src/domain/types.ts | 1 | 0 | 1 |
| src/i18n/config.ts | 1 | 0 | 1 |
| src/i18n/request.ts | 1 | 0 | 1 |
| src/instrumentation-node.ts | 1 | 0 | 1 |
| src/instrumentation.ts | 1 | 0 | 1 |
| src/lib/a2a | 11 | 0 | 11 |
| src/lib/accessTokens | 1 | 0 | 1 |
| src/lib/acp | 3 | 0 | 3 |
| src/lib/admissionVirtualLanes.ts | 1 | 0 | 1 |
| src/lib/agentSkills | 8 | 0 | 8 |
| src/lib/alerts | 1 | 0 | 1 |
| src/lib/api | 14 | 0 | 14 |
| src/lib/apiBridgeServer.ts | 1 | 0 | 1 |
| src/lib/apiKeyExposure.ts | 1 | 0 | 1 |
| src/lib/arenaEloSync.ts | 1 | 0 | 1 |
| src/lib/audio | 1 | 0 | 1 |
| src/lib/audit | 3 | 0 | 3 |
| src/lib/auth | 11 | 0 | 11 |
| src/lib/batches | 7 | 0 | 7 |
| src/lib/branding | 1 | 0 | 1 |
| src/lib/build-profile | 1 | 0 | 1 |
| src/lib/buildPhase.ts | 1 | 0 | 1 |
| src/lib/cache | 2 | 0 | 2 |
| src/lib/cacheControlSettings.ts | 1 | 0 | 1 |
| src/lib/cacheLayer.ts | 1 | 0 | 1 |
| src/lib/catalog | 3 | 3 | 0 |
| src/lib/catalogVersion.ts | 1 | 0 | 1 |
| src/lib/ccDiscoveryAliasResolve.ts | 1 | 0 | 1 |
| src/lib/chaos | 2 | 0 | 2 |
| src/lib/cli-helper | 19 | 0 | 19 |
| src/lib/clientDiscovery.ts | 1 | 0 | 1 |
| src/lib/cliTools | 2 | 0 | 2 |
| src/lib/cloudAgent | 12 | 0 | 12 |
| src/lib/cloudflaredNamedTunnel.ts | 1 | 0 | 1 |
| src/lib/cloudflaredTunnel.ts | 1 | 0 | 1 |
| src/lib/cloudSync.stub.ts | 1 | 0 | 1 |
| src/lib/cloudSync.ts | 1 | 0 | 1 |
| src/lib/comboBulk.ts | 1 | 0 | 1 |
| src/lib/comboPresets.ts | 1 | 0 | 1 |
| src/lib/combos | 13 | 0 | 13 |
| src/lib/compliance | 4 | 0 | 4 |
| src/lib/compression | 1 | 0 | 1 |
| src/lib/conductor | 5 | 0 | 5 |
| src/lib/config | 2 | 0 | 2 |
| src/lib/consoleInterceptor.ts | 1 | 0 | 1 |
| src/lib/consoleLogEntries.ts | 1 | 0 | 1 |
| src/lib/consoleLogTail.ts | 1 | 0 | 1 |
| src/lib/container.ts | 1 | 0 | 1 |
| src/lib/contextWindowResolver.ts | 1 | 0 | 1 |
| src/lib/copilot | 5 | 0 | 5 |
| src/lib/credentialHealth | 3 | 0 | 3 |
| src/lib/cursor | 2 | 0 | 2 |
| src/lib/dataPaths.ts | 1 | 0 | 1 |
| src/lib/db | 238 | 12 | 226 |
| src/lib/discovery | 1 | 0 | 1 |
| src/lib/display | 2 | 0 | 2 |
| src/lib/docsLinkResolver.ts | 1 | 0 | 1 |
| src/lib/docsSanitizer.ts | 1 | 0 | 1 |
| src/lib/embeddings | 4 | 0 | 4 |
| src/lib/env | 1 | 0 | 1 |
| src/lib/evals | 3 | 0 | 3 |
| src/lib/events | 2 | 0 | 2 |
| src/lib/exclusiveLeaseIsolation.ts | 1 | 0 | 1 |
| src/lib/freeProviderRankings.ts | 1 | 0 | 1 |
| src/lib/freeProviderRankingsAuthType.ts | 1 | 0 | 1 |
| src/lib/freeProviderRankingsUsage.ts | 1 | 0 | 1 |
| src/lib/freeProxyProviders | 8 | 0 | 8 |
| src/lib/gracefulShutdown.ts | 1 | 0 | 1 |
| src/lib/guardrails | 45 | 0 | 45 |
| src/lib/headroom | 2 | 0 | 2 |
| src/lib/healthzLag.ts | 1 | 0 | 1 |
| src/lib/idempotencyLayer.ts | 1 | 0 | 1 |
| src/lib/images | 1 | 0 | 1 |
| src/lib/initCloudSync.ts | 1 | 0 | 1 |
| src/lib/inspector | 6 | 0 | 6 |
| src/lib/instrumentationBootError.ts | 1 | 0 | 1 |
| src/lib/ipUtils.ts | 1 | 0 | 1 |
| src/lib/issueAgent | 4 | 0 | 4 |
| src/lib/jobRegistry | 4 | 0 | 4 |
| src/lib/jobs | 7 | 0 | 7 |
| src/lib/kimi | 2 | 0 | 2 |
| src/lib/localCorpus | 2 | 0 | 2 |
| src/lib/localHealthCheck.ts | 1 | 0 | 1 |
| src/lib/logEnv.ts | 1 | 0 | 1 |
| src/lib/logExport | 9 | 1 | 8 |
| src/lib/logPayloads.ts | 1 | 0 | 1 |
| src/lib/logRotation.ts | 1 | 0 | 1 |
| src/lib/machineToken.ts | 1 | 0 | 1 |
| src/lib/mcp | 14 | 0 | 14 |
| src/lib/memory | 31 | 0 | 31 |
| src/lib/metrics | 2 | 0 | 2 |
| src/lib/middleware | 3 | 0 | 3 |
| src/lib/modelAliasResolver.ts | 1 | 0 | 1 |
| src/lib/modelAliasSeed.ts | 1 | 0 | 1 |
| src/lib/modelCapabilities.ts | 1 | 0 | 1 |
| src/lib/modelCapabilityModalities.ts | 1 | 0 | 1 |
| src/lib/modelCapabilityOverrideTargets.ts | 1 | 0 | 1 |
| src/lib/modelCapabilityResolutionSnapshot.ts | 1 | 0 | 1 |
| src/lib/modelMetadataRegistry.ts | 1 | 0 | 1 |
| src/lib/modelRecommendations.ts | 1 | 1 | 0 |
| src/lib/modelsDevSync | 1 | 0 | 1 |
| src/lib/modelsDevSync.ts | 1 | 0 | 1 |
| src/lib/monitoring | 5 | 0 | 5 |
| src/lib/ngrokTunnel.ts | 1 | 0 | 1 |
| src/lib/notion | 1 | 0 | 1 |
| src/lib/oauth | 67 | 8 | 59 |
| src/lib/obsidian | 1 | 0 | 1 |
| src/lib/obsidianSync.ts | 1 | 0 | 1 |
| src/lib/omnirouteStatus.ts | 1 | 0 | 1 |
| src/lib/piiSanitizer.ts | 1 | 0 | 1 |
| src/lib/playground | 4 | 0 | 4 |
| src/lib/plugins | 14 | 0 | 14 |
| src/lib/pricingSync.ts | 1 | 0 | 1 |
| src/lib/promptCache | 3 | 0 | 3 |
| src/lib/providerFamilyAgg.ts | 1 | 0 | 1 |
| src/lib/providerModels | 26 | 0 | 26 |
| src/lib/providerNodePrefixes.ts | 1 | 0 | 1 |
| src/lib/providers | 62 | 0 | 62 |
| src/lib/proxyEchoTarget.ts | 1 | 0 | 1 |
| src/lib/proxyEgress.ts | 1 | 0 | 1 |
| src/lib/proxyEvents | 1 | 0 | 1 |
| src/lib/proxyHealth | 7 | 0 | 7 |
| src/lib/proxyHealth.ts | 1 | 0 | 1 |
| src/lib/proxyLogger.ts | 1 | 0 | 1 |
| src/lib/proxyPoolEgressObservation.ts | 1 | 0 | 1 |
| src/lib/proxyPresets | 3 | 0 | 3 |
| src/lib/proxyRelay | 2 | 0 | 2 |
| src/lib/proxySubscription | 15 | 0 | 15 |
| src/lib/quota | 28 | 2 | 26 |
| src/lib/radar | 19 | 0 | 19 |
| src/lib/reasoningRouting | 2 | 0 | 2 |
| src/lib/recommendedCombos.ts | 1 | 0 | 1 |
| src/lib/recovery | 1 | 0 | 1 |
| src/lib/resilience | 6 | 3 | 3 |
| src/lib/retainedSize.ts | 1 | 0 | 1 |
| src/lib/routerEval | 1 | 0 | 1 |
| src/lib/routing | 4 | 1 | 3 |
| src/lib/runtime | 3 | 0 | 3 |
| src/lib/search | 1 | 0 | 1 |
| src/lib/security | 2 | 0 | 2 |
| src/lib/semanticCache.ts | 1 | 0 | 1 |
| src/lib/serverLifecycle.ts | 1 | 0 | 1 |
| src/lib/services | 26 | 1 | 25 |
| src/lib/sessionObservability.ts | 1 | 0 | 1 |
| src/lib/setup | 3 | 0 | 3 |
| src/lib/skills | 23 | 0 | 23 |
| src/lib/source.ts | 1 | 0 | 1 |
| src/lib/spend | 1 | 0 | 1 |
| src/lib/sseTextTransform.ts | 1 | 0 | 1 |
| src/lib/startup | 1 | 0 | 1 |
| src/lib/streamingPiiTransform.ts | 1 | 0 | 1 |
| src/lib/sync | 2 | 0 | 2 |
| src/lib/system | 7 | 0 | 7 |
| src/lib/tailscaleServe.ts | 1 | 0 | 1 |
| src/lib/tailscaleTunnel.ts | 1 | 0 | 1 |
| src/lib/telegram | 5 | 0 | 5 |
| src/lib/tokenHealthCheck.ts | 1 | 0 | 1 |
| src/lib/tokenHealthCheckCopilot.ts | 1 | 0 | 1 |
| src/lib/tokenHealthCheckCursor.ts | 1 | 0 | 1 |
| src/lib/tokenHealthCheckExpiry.ts | 1 | 0 | 1 |
| src/lib/tokenHealthCheckKimi.ts | 1 | 0 | 1 |
| src/lib/tokenHealthCheckProxyGuard.ts | 1 | 0 | 1 |
| src/lib/tokenHealthCheckWebCookie.ts | 1 | 0 | 1 |
| src/lib/tokenRefreshCircuit.ts | 1 | 0 | 1 |
| src/lib/toolPolicy.ts | 1 | 0 | 1 |
| src/lib/translator | 1 | 0 | 1 |
| src/lib/translatorEvents.ts | 1 | 0 | 1 |
| src/lib/usage | 56 | 1 | 55 |
| src/lib/usageAnalytics.ts | 1 | 0 | 1 |
| src/lib/usageDb.ts | 1 | 0 | 1 |
| src/lib/usageSinks | 12 | 2 | 10 |
| src/lib/versionManager | 5 | 0 | 5 |
| src/lib/vncSession | 3 | 0 | 3 |
| src/lib/vscode | 5 | 0 | 5 |
| src/lib/warmupScheduler | 6 | 0 | 6 |
| src/lib/warmupScheduler.ts | 1 | 0 | 1 |
| src/lib/webhookDispatcher.ts | 1 | 0 | 1 |
| src/lib/webhooks | 4 | 0 | 4 |
| src/lib/wellKnown.ts | 1 | 0 | 1 |
| src/lib/wireguard | 8 | 0 | 8 |
| src/lib/ws | 1 | 0 | 1 |
| src/lib/zed-oauth | 6 | 0 | 6 |
| src/middleware/promptInjectionGuard.ts | 1 | 0 | 1 |
| src/mitm/_internal | 7 | 0 | 7 |
| src/mitm/aliasConfig.ts | 1 | 0 | 1 |
| src/mitm/cert | 6 | 0 | 6 |
| src/mitm/dataDir.ts | 1 | 0 | 1 |
| src/mitm/detection | 9 | 0 | 9 |
| src/mitm/dns | 2 | 0 | 2 |
| src/mitm/handlers | 10 | 0 | 10 |
| src/mitm/inspector | 13 | 0 | 13 |
| src/mitm/manager.runtime.ts | 1 | 0 | 1 |
| src/mitm/manager.stub.ts | 1 | 0 | 1 |
| src/mitm/manager.ts | 1 | 0 | 1 |
| src/mitm/maskSecrets.ts | 1 | 0 | 1 |
| src/mitm/passthrough.ts | 1 | 0 | 1 |
| src/mitm/privilegedMitmStep.ts | 1 | 0 | 1 |
| src/mitm/repair.ts | 1 | 0 | 1 |
| src/mitm/sanitizeHeaders.ts | 1 | 0 | 1 |
| src/mitm/server.cjs | 1 | 0 | 1 |
| src/mitm/socketTimeouts.ts | 1 | 0 | 1 |
| src/mitm/stopDnsTeardown.ts | 1 | 0 | 1 |
| src/mitm/sudoGate.ts | 1 | 0 | 1 |
| src/mitm/systemCommands.ts | 1 | 0 | 1 |
| src/mitm/targets | 11 | 0 | 11 |
| src/mitm/tproxy | 8 | 0 | 8 |
| src/mitm/types.ts | 1 | 0 | 1 |
| src/mitm/upstreamTrust.ts | 1 | 0 | 1 |
| src/models/index.ts | 1 | 1 | 0 |
| src/proxy.ts | 1 | 0 | 1 |
| src/scripts/backfillAggregation.ts | 1 | 0 | 1 |
| src/server/auth | 2 | 0 | 2 |
| src/server/authz | 18 | 0 | 18 |
| src/server/cors | 1 | 0 | 1 |
| src/server/origin | 2 | 0 | 2 |
| src/server/ws | 3 | 0 | 3 |
| src/shared/constants | 99 | 3 | 96 |
| src/shared/contracts | 1 | 0 | 1 |
| src/shared/design-system | 14 | 0 | 14 |
| src/shared/http | 1 | 0 | 1 |
| src/shared/icons | 3 | 0 | 3 |
| src/shared/middleware | 11 | 1 | 10 |
| src/shared/network | 9 | 0 | 9 |
| src/shared/platform | 1 | 0 | 1 |
| src/shared/providers | 1 | 0 | 1 |
| src/shared/reasoning | 4 | 0 | 4 |
| src/shared/resilience | 1 | 0 | 1 |
| src/shared/schemas | 9 | 0 | 9 |
| src/shared/services | 22 | 0 | 22 |
| src/shared/types | 4 | 0 | 4 |
| src/shared/utils | 102 | 1 | 101 |
| src/shared/validation | 35 | 0 | 35 |
| src/sse/handlers | 26 | 0 | 26 |
| src/sse/services | 40 | 0 | 40 |
| src/sse/utils | 2 | 0 | 2 |
| src/store/emailPrivacyStore.ts | 1 | 0 | 1 |
| src/store/index.ts | 1 | 0 | 1 |
| src/store/jsonTreeExpandStore.ts | 1 | 0 | 1 |
| src/store/notificationStore.ts | 1 | 0 | 1 |
| src/store/themeStore.ts | 1 | 0 | 1 |
| src/types/databaseSettings.ts | 1 | 0 | 1 |
| src/types/index.ts | 1 | 0 | 1 |
| src/types/provider.ts | 1 | 0 | 1 |
| src/types/resilience.ts | 1 | 0 | 1 |

## Audit findings and resumption order

The implementation remains paused. No entries have been marked ported or verified by this audit.

The readable JSON index links a SHA-256-checked gzip archive with the complete per-file crosswalk, imports, original blob provenance, historical tests and planning batches. Inspect a file with **node scripts/research/rustify-report.mjs --find src/lib/db/providers.ts**. This reads the archive only; it does not rerun Rustify or execute the application.

1. **Alias model quota gap (P0).** Dispatch passes the target model to native reservation accounting (rust/red-routerd/src/lib.rs:6244). Model quota lookup and completed/pending usage match that target (native_usage.rs:743). A quota configured for a distinct public alias is not checked on this path. Before deploying aliases, preserve both requested and actual model attribution and verify alias limits across target changes, concurrent workers, streaming, restart and settlement. This is a static finding, not a newly executed exploit or regression test. No fix was made here.
2. **Dependency cycles.** 11 nontrivial import cycles were identified; the largest contains 261 modules. Rustify keeps cycles in one planning unit even when they exceed its batch size. These units must be decomposed by product contract when implementation resumes; they are not a directive to recreate the legacy coupling.
3. **Scope of missing candidates.** 3504 backend/shared files have no candidate from the current explicit-anchor/symbol search. This is an investigation queue, not proof that every file needs a new Rust implementation. 1320 files have candidates whose contracts still require review.
4. **Resolver limitations.** 0 resolved internal import edges are absent from the Rustify graph; 0 internal alias entries remain classified as external. Review these explicit lists in JSON before using the dependency order. Nonliteral imports and generated modules remain separately listed. A CSS import and generated documentation source can be outside the code graph without being missing backend features.

### Cyclic planning units

| Rustify unit | Files | Examples |
| --- | ---: | --- |
| 1015 | 261 | `open-sse/config/cliFingerprints.ts`, `open-sse/executors/antigravity.ts`, `open-sse/executors/antigravity/executeAttempt.ts`, `open-sse/executors/antigravityOutputCap.ts`, … (full list in JSON) |
| 2198 | 5 | `open-sse/handlers/imageGeneration.ts`, `open-sse/handlers/imageGeneration/providers/adobeFirefly.ts`, `open-sse/handlers/imageGeneration/providers/cursorAgentImage.ts`, `open-sse/handlers/imageGeneration/providers/maxaiImage.ts`, … (full list in JSON) |
| 1560 | 4 | `open-sse/services/alibabaFreeTier.ts`, `open-sse/services/alibabaFreeTierDiscovery.ts`, `open-sse/services/alibabaFreeTierQuotaClassify.ts`, `open-sse/services/alibabaFreeTierQuotaFetcher.ts` |
| 2281 | 3 | `open-sse/mcp-server/catalog.ts`, `open-sse/mcp-server/radarCatalog.ts`, `open-sse/mcp-server/server.ts` |
| 1431 | 2 | `open-sse/executors/opencode.ts`, `open-sse/executors/opencodeFreeTierRetry.ts` |
| 1481 | 2 | `open-sse/handlers/audioTranscription.ts`, `open-sse/handlers/openrouterTranscription.ts` |
| 1799 | 2 | `open-sse/services/combo.ts`, `open-sse/services/combo/roundRobinCombo.ts` |
| 3187 | 2 | `src/app/(dashboard)/dashboard/costs/CostOverviewTab.tsx`, `src/app/(dashboard)/dashboard/costs/components/TopListCard.tsx` |
| 1879 | 2 | `src/lib/plugins/hooks.ts`, `src/lib/plugins/manager.ts` |
| 2647 | 2 | `src/lib/proxySubscription/selectorTrigger.ts`, `src/lib/proxySubscription/subscriptionService.ts` |
| 2741 | 2 | `src/shared/constants/dashboardUrls.ts`, `src/shared/constants/sidebarNav.ts` |

### All 32 provider field groups

These are the existing field-level audit, including both implemented subsets and remaining gaps; they are not 32 wholly absent features.

| ID | Priority / complexity | Legacy feature / fields | Current gap and next acceptance |
| --- | --- | --- | --- |
| PV-01 | P0 / M | Connection name, `display_name`, email | Native CRUD, SPA and API/OAuth import now accept the legacy 200 UTF-16-unit limit, including Unicode without truncation. CI regressions cover both import paths; email and identity precedence remain under review. |
| PV-02 | P0 / M | `priority` per provider | Missing connection-level contract; combo target order is a different policy. API-key import now rejects nonzero persisted account priorities instead of silently discarding them (full Rust CI passed at `444aded25`). Preserve order across accounts/restart/import before lifting this refusal. |
| PV-03 | P0 / M | `globalPriority` | Missing contract; resolve provider/account precedence and null semantics. |
| PV-04 | P0 / M | `defaultModel` | Missing connection default; route model is not a connection default. Trace omitted-model resolution. |
| PV-05 | P0 / M | `group` | Missing provider grouping/filter/routing contract and migration. |
| PV-06 | P0 / L | `maxConcurrent` | Native target in-flight metrics exist; legacy provider admission/queue setting still needs an independent port. No arbitrary global agent cap. |
| PV-07 | P0 / L | `rateLimitOverrides.rpm/rpd/tpm/tpd` | Missing provider override contract; client key quotas are a different scope. Shared admission/reset/import tests. |
| PV-08 | P0 / L | `minTime/maxWaitMs/executionMaxWaitMs` | Missing queue controls; distinguish dispatch spacing, queue timeout and execution timeout. |
| PV-09 | P0 / L | `quotaWindowThresholds` | Native session/weekly quota view is partial; per-window patches, null clearing and arbitrary supported windows need mapping. |
| PV-10 | P1 / M | `quotaVisible`, auto refresh | Missing display preference; review refresh enablement versus durable quota workers. |
| PV-11 | P0 / M | `healthCheckInterval` | Diagnostics exist; per-account scheduled health checks/configuration not established. |
| PV-12 | P0 / M | `testStatus/lastTested/lastError/lastErrorAt/lastErrorType/lastErrorSource/errorCode` | Native diagnostics/availability are partial; durable detailed history/import/SPA still missing. |
| PV-13 | P0 / L | `rateLimitedUntil` | Native cooldown exists; verify timestamp import, reset semantics and terminal states. |
| PV-14 | P0 / L | `proxyEnabled/perKeyProxyEnabled` | Missing outbound proxy selection/configuration/transport and migration. |
| PV-15 | P0 / L | `projectId` / provider-specific region or account identity | Antigravity session metadata is partial; enumerate per-executor required fields before supporting other provider families. |
| PV-16 | P0 / M | `customHeaders` on compatible nodes | New encrypted write-only native map + SPA editor; dispatch, combo/internal calls and diagnostics wired. CI passed for native account headers. Encrypted definition defaults now merge with account overrides in runtime snapshots; version-checked writes protect shared configuration and removal invalidates the bounded cache. Inheritance passed the full Rust suite at `86d217044`, including restart/cache invalidation and concurrent writes; browser save/reload/detach/remove passed at `2af7463f1`. Legacy node/connection import remains open. |
| PV-17 | P0 / L | Node `name/prefix/type/apiType/baseUrl` | Native tenant-scoped definitions now persist name/prefix/protocol/base URL and account bindings, with SPA CRUD, inherited runtime transport, namespace guards and explicit approval for shared endpoint changes. Legacy node import, presets, remaining types and distributed lifecycle races still require acceptance. |
| PV-18 | P0 / M | Node `chatPath/modelsPath` | Recognized inference endpoint URLs plus persisted per-connection model-discovery paths and SPA querying now exist. Discovery preserves same-origin credentials, pagination and bounded responses. Explicit native API protocol selection now allows arbitrary inference paths and persists across restart, diagnostics and combos; Protocol persistence passed CI at `6ccb581b4`. Reusable definition transport and model-discovery inheritance now exist; legacy node import remains open. |
| PV-19 | P1 / S | Node `iconUrl` | Missing custom branding field/display/migration. Validate remote image source separately from inference URL. |
| PV-20 | P0 / M | Node `dailyQuotaResetTimezone/dailyQuotaResetHour` | Missing node-specific reset contract; verify DST and exact window boundaries. |
| PV-21 | P0 / M | Node presets / `compatMode` | Review each preset; a generic compatible URL must not be advertised as native CLI compatibility. |
| PV-22 | P0 / M | Credential optional providers / `allowOverwrite` | Explicit native `auth_scheme:none` now supports local/public APIs without fabricated credentials, including dispatch, combos, diagnostics and discovery; client authentication remains mandatory. SPA tests passed (229 total at `444aded25`); SQLite restart/inference regressions passed the full Rust run at `444aded25`; browser create/reload passed at `84b405406`. Legacy no-auth import and explicit duplicate-name replacement remain open. |
| PV-23 | P0 / L | Bulk create/import API credentials, validation and batch enable/test | OAuth import subset exists. Preserve partial failure reporting, duplicate policy and account identity for API credentials. |
| PV-24 | P0 / L | OAuth authorize/device/import/refresh/revoke per executor | Six native OAuth kinds are not all historical flows. Enumerate every legacy executor and prove identity, expiry, concurrency and revocation separately. |
| PV-25 | P0 / L | Custom provider model add/update/delete | Tenant-scoped custom metadata CRUD, optimistic revisions, SQLite persistence, SPA editor and replica snapshot refresh are implemented; Product checks, 231 UI tests and real-browser CRUD passed at `e802f95ac`; the full Rust suite passed at `935d41271` (run `43423604333`). Metadata feeds authorized discovery, combo limits/costs and token metering without granting routes. Legacy model import, discovery reconciliation and automatic routing remain open. |
| PV-26 | P0 / M | Model aliases `from/to` | Tenant-scoped operator aliases now have a native CRUD contract, SQLite revision checks, SPA editor and provider-account routing snapshot (acceptance pending). Public names are retained in JSON/SSE replies; target denies and tenant ownership are checked. **Open quota gap:** native reservation checks use the upstream target model, so a per-model quota keyed by the public alias is not covered. Preserve both requested and actual model accounting and add target-change/concurrency regressions before accepting or deploying this slice. Existing static permission aliases are separate. Legacy alias import, managed-sync provenance/pruning, aliases to combos and exact legacy account-priority semantics remain open. |
| PV-27 | P0 / L | Model `apiFormat/supportedEndpoints/targetFormat/compatByProtocol` | Protocol translators exist; per-model overrides/configuration and migration not established. |
| PV-28 | P0 / M | Model `contextWindowOverride/max_input_tokens/max_output_tokens` | Custom context/input/output overrides now persist and merge with catalog metadata; combo context fallback and authorized model discovery consume them. Explicit combo settings retain precedence. Native and SPA/browser checks passed; legacy import and provider-specific runtime enforcement remain open. |
| PV-29 | P1 / M | Model `supportsVision/dimensions/supportedInputTypes/modelType/isFree` | Tenant-scoped custom capabilities/modalities/type and per-token prices now have durable API/SPA management; false and zero are explicit overrides, absent fields inherit catalog values. Native and SPA/browser checks passed. Legacy dimensions/isFree mapping and import remain open. |
| PV-30 | P0 / L | Model `normalizeToolCallId/preserveOpenAIDeveloperRole/upstreamHeaders/generationConfig` | Translators have fixed behavior; per-model controls and runtime effects need implementation. Provider headers do not close model headers. |
| PV-31 | P1 / L | Parameter filters `block/allow/models/autoLearn` | Missing operator-facing contract and learning lifecycle; do not silently discard unsupported request parameters. |
| PV-32 | P1 / L | Search/fetch interception `interceptSearch/interceptFetch/fetchBackend/fetchProxyUrl/models` | Missing endpoint-specific configuration and search transport integration. |

### Resumption queue: priority first, complexity second

S → M → L → XL within each priority. Dependency order, risk and user-visible replacement needs may override this static ordering. Start with the alias quota blocker, provider configuration/import, identity/policies and cutover before optional subsystems. Keep the frontend as a SPA.

| ID | Priority / complexity | Capability / state |
| --- | --- | --- |
| API-10 | P0 / M | Measured latency, memory and concurrency |
| CORE-01 | P0 / M | Rail, panel, tabs, deep links — Partial |
| CORE-02 | P0 / M | Model/provider catalog — Partial |
| CORE-12 | P0 / M | Production start, SPA serving and durable SQLite — Partial |
| UI-40 | P0 / M | Storage/general settings |
| API-01 | P0 / L | Every protocol's request/response and error contracts |
| API-05 | P0 / L | Legacy field compatibility and unsupported-policy migration |
| API-08 | P0 / L | Data-domain completeness |
| API-09 | P0 / L | Durable side effects and background workers |
| CORE-03 | P0 / L | Provider CRUD and advanced configuration — Partial |
| CORE-04 | P0 / L | Provider OAuth accounts and sessions — Partial |
| CORE-05 | P0 / L | Named client keys and policies — Partial |
| CORE-06 | P0 / L | Counters, token limits, spend and shared budgets — Partial |
| CORE-07 | P0 / L | Combos and automatic routing — Partial |
| CORE-08 | P0 / L | Account cooldown, provider breaker, model lockout — Partial |
| CORE-09 | P0 / L | Existing data cutover — Partial / blocker |
| CORE-10 | P0 / L | Organization, membership, OIDC and provisioning — Partial |
| CORE-11 | P0 / L | Usage/history/cost records — Partial |
| UI-43 | P0 / L | Routing / advanced settings |
| UI-44 | P0 / L | Security settings beyond OIDC |
| API-04 | P0 / XL | Provider transport/auth coverage |
| UI-01 | P1 / S | Setup/onboarding |
| UI-33 | P1 / S | API endpoint explorer |
| UI-41 | P1 / S | Appearance and sidebar settings |
| UI-02 | P1 / M | Home topology |
| UI-04 | P1 / M | Provider stats / utilization |
| UI-07 | P1 / M | Free tiers and provider rankings |
| UI-25 | P1 / M | Pricing overrides |
| UI-26 | P1 / M | Provider quota view |
| UI-29 | P1 / M | Audit log |
| UI-30 | P1 / M | Health / runtime / connections |
| UI-32 | P1 / M | Log export / usage sinks / BigQuery |
| UI-34 | P1 / M | Playground |
| UI-35 | P1 / M | Translator UI |
| UI-38 | P1 / M | Discovery |
| UI-42 | P1 / M | Prompt and AI settings |
| UI-45 | P1 / M | Feature flags |
| UI-49 | P1 / M | Docs/help links |
| API-02 | P1 / L | Audio/TTS/transcription, image/video and multimodal routes |
| API-03 | P1 / L | Search/fetch, files, batches and remaining v1 protocols |
| API-06 | P1 / L | Guardrails/hooks/PII/security policy |
| API-07 | P1 / L | Pricing/dynamic provider metadata refresh |
| UI-03 | P1 / L | Usage analytics |
| UI-05 | P1 / L | Combo health / live view / route trace |
| UI-09 | P1 / L | Local embedded services |
| UI-10 | P1 / L | Media provider management |
| UI-12 | P1 / L | MCP endpoint and tools |
| UI-15 | P1 / L | Compression combos/studio/live/analytics |
| UI-16 | P1 / L | Response/cache management and cache health |
| UI-17 | P1 / L | Media cache |
| UI-20 | P1 / L | CLI code integrations |
| UI-27 | P1 / L | Request/proxy/console logs |
| UI-28 | P1 / L | Timeline / conversations / activity |
| UI-31 | P1 / L | Generic event webhooks |
| UI-36 | P1 / L | Search tools and web fetch |
| UI-39 | P1 / L | Network / tunnels / outbound proxies |
| UI-48 | P1 / L | Batch jobs and files |
| UI-14 | P1 / XL | Token saver / compression engines |
| UI-06 | P2 / L | Search analytics and evals |
| UI-08 | P2 / L | Radar |
| UI-11 | P2 / L | Relay |
| UI-13 | P2 / L | A2A server and audit |
| UI-18 | P2 / L | Skills/catalog/prompt styles |
| UI-23 | P2 / L | Agent bridge |
| UI-37 | P2 / L | Traffic inspector |
| UI-46 | P2 / L | Modality bridge |
| UI-47 | P2 / L | Chaos mode |
| UI-19 | P2 / XL | Conversation memory |
| UI-21 | P2 / XL | CLI agents / ACP / cloud agents |
| UI-22 | P2 / XL | Conductor / orchestration |
| UI-24 | P2 / XL | Plugins |

Acceptance for each row remains: historical behavior → Rust contract → SQLite effects → SPA operation → behavioral CI evidence. Include denied/error paths and concurrency where applicable. Current catalog entries, same-path routes, matching symbols and a green Rustify command are not acceptance evidence.
