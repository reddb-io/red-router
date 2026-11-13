# RedRouter backend and dashboard parity backlog

Audit date: 2026-11-12. Legacy baseline: `525a71de4ac25968d0a25e52eeb1b09cc21c6e92`
(v0.60.5, last first-parent main commit as of 2026-10-29). The newer main commits
through 2026-11-08 concern CI. This is our product baseline, including its inherited
capabilities, not a new comparison against today's upstream feature lists.

**The port is not complete.** There are 15 SPA pages versus 106 historical navigation
surfaces across 33 groups and 8 areas. 69 historical surfaces have no SPA route;
35 resolve to a page but need behavioral review; 2 are external links. None of those
counts is a feature-completion percentage. There are 803 legacy API route files and
80 registered Rust paths. Renamed/consolidated APIs must be traced, not automatically
classified as missing. Full route-by-route evidence and source file paths are in
[the generated inventory](LEGACY_RUST_PARITY_INVENTORY.md) and
[the machine-readable inventory](../../config/upstream/legacy-rust-parity.json).

## Status and acceptance rules

- **Partial**: concrete Rust/SPA implementation exists; named differences remain or behavioral equivalence is unproven.
- **Missing UI**: the historical task has no dedicated SPA flow; an alias is not a replacement.
- **Missing surface**: no corresponding registered Rust route/SPA flow found in this audit. Internal utilities may exist; trace them before implementing.
- **Review**: source present but evidence does not establish equivalence. Never count this as complete.
- **Complete** requires old behavior → Rust API → SQLite state → SPA action → regression evidence, including denial/error behavior. A feature that requires credentials also needs a documented provider smoke test before calling its integration verified.

Complexity is relative: S = focused existing API/UI integration; M = several contracts or state transitions;
L = new durable domain/protocol; XL = cross-cutting pipeline/runtime subsystem.
Priority is independent: P0 blocks a safe replacement of core operations; P1 restores
important product capability; P2 restores additional subsystems. All remain in scope.

## Core replacement: first execution wave

| ID | Priority / complexity | Capability and current state | Legacy evidence → new implementation | Remaining work and acceptance |
| --- | --- | --- | --- | --- |
| CORE-01 | P0 / M | Rail, panel, tabs, deep links — Partial | `src/shared/constants/sidebarNav.ts`, `src/shared/components/shell/` → `rust-dashboard/main.tsx`, `routes.ts` | Restore the original 8-area taxonomy, entry tabs, breadcrumbs, search, visibility and mobile navigation as their features land. Do not expose dummy actions or count aliases as ports. Deep-link and keyboard E2E. |
| CORE-02 | P0 / M | Model/provider catalog — Partial | `src/app/(dashboard)/dashboard/models/`, `src/lib/catalog/` → `catalog.rs`, `ModelCatalog.tsx` | Port global/provider/type search, sorting, pagination, full capability/context/cache-price metadata, model links and freshness/retry states. Distinguish listed metadata from configured/authorized providers. Bound rendering and avoid stale results after changing provider. |
| CORE-03 | P0 / L | Provider CRUD and advanced configuration — Partial | `src/app/api/providers/`, `src/app/api/provider-nodes/` → `control_plane.rs`, `RustProvidersPageClient.tsx` | Field-by-field mapping of endpoint/auth/header/model/region/project/proxy settings. Preserve secrets on metadata edits; never return secrets in list responses. Test create/edit/test/disable/delete/reload for every supported transport. |
| CORE-04 | P0 / L | Provider OAuth accounts and sessions — Partial | `src/app/api/oauth/`, `open-sse/executors/`, provider auth imports → `control_plane.rs`, `RustProviderOAuthModal.tsx`, `RustProviderSessionImportModal.tsx` | Enumerate old provider auth flows separately from API-compatible IDs. Test authorize/callback/device/import/refresh/revoke, expired/banned states and competing refreshes. Keep Gemini CLI retired; preserve Antigravity. Use supported CLI integrations; never disguise clients to bypass provider controls. |
| CORE-05 | P0 / L | Named client keys and policies — Partial | `src/app/api/api-keys/`, `src/lib/db/apiKeys.ts` → `policy.rs`, `control_plane.rs`, `RustApiManagerPageClient.tsx` | Compare every policy field and route restriction, custom headers, schedules, groups/tags/users, key routing and identity propagation. Preserve tenant ownership and human-readable labels; no RedDB database ID coupling. Test allowed and denied requests, not just CRUD. |
| CORE-06 | P0 / L | Counters, token limits, spend and shared budgets — Partial | `src/app/api/usage/`, budget/quota DB modules → `accounting.rs`, `shared_usage.rs`, `shared_budget.rs`, `reconcile.rs`, key modal and `SharedBudgets.tsx` | Trace per-model limits (UI already exists), daily/monthly/reset windows, pending reservations and streaming disconnects. Preserve counters during cutover. Prove parallel-worker admission and exactly-once settlement without silently capping all agents. |
| CORE-07 | P0 / L | Combos and automatic routing — Partial | `open-sse/services/`, `src/app/api/combos/` → `control_plane.rs`, `product_combo.rs`, `RustCombosPageClient.tsx` | Separate native combo support from narrow legacy combo reader. Compare all strategies/config fields, prompts, fallback conditions, route pins, context relay and limits. Dedicated live/test-combo pages are missing; prefix aliases are not implementations. |
| CORE-08 | P0 / L | Account cooldown, provider breaker, model lockout — Partial | `open-sse/services/accountFallback.ts`, `src/shared/utils/circuitBreaker.ts` → `availability.rs`, `circuit.rs`, `resilience.rs`, `ProviderResilience.tsx` | Trace each scope, Retry-After, half-open probes, quota reset and terminal account states. Test simultaneous failures do not repeatedly extend cooldown or retry unusable credentials. |
| CORE-09 | P0 / L | Existing data cutover — Partial / blocker | old SQLite domain modules → `legacy_keys.rs`, `legacy_providers.rs`, `legacy_quota.rs`, `legacy_archive.rs`, `legacy_cutover.rs` | Importers still reject legacy behaviors they cannot preserve; do not remove these checks. Inventory populated tables/settings, migrate supported rows transactionally, report unsupported fields, preserve ciphertext/key hashes and identity, rehearse backup/import/restart/rollback on disposable copies. An archive is not an operational port. |
| CORE-10 | P0 / L | Organization, membership, OIDC and provisioning — Partial | tenants/users/roles/authz APIs → `oidc.rs`, `control_plane.rs`, `Organizations.tsx`, `OidcSettings.tsx` | Compare membership and fine-grained roles with current identity bindings. Users/roles aliases currently open Organizations. Test two tenants, issuer/subject mapping, key provisioning, revocation, CSRF/session expiry and cross-tenant denial. |
| CORE-11 | P0 / L | Usage/history/cost records — Partial | usage, request-cost ledger, analytics APIs → `native_usage.rs`, `UsageReport.tsx`, `LegacyUsage.tsx` | Verify model/key/provider/account/request attribution, pricing at request time, cached/reasoning tokens, filters/pagination, retention and drill-down. Aggregate usage does not replace logs/timeline/conversations. |
| CORE-12 | P0 / M | Production start, SPA serving and durable SQLite — Partial | CLI/Electron/start scripts → `main.rs`, `spa.rs`, runtime packaging | Test install, upgrade, base paths/deep links, persistent data directory, backups, shutdown/drain, authenticated SPA and no Node backend. Current local preview uses disposable data: do not restart/delete it during SPA updates. |

## Full product surface: ordered restoration backlog

Every row below is open; the generated inventory enumerates each individual page under these groups.
Missing surface is based on the registered production router, not a claim that no helper code exists.

| ID | Priority / complexity | Legacy functionality | State / implementation anchor | Required behavior before acceptance |
| --- | --- | --- | --- | --- |
| UI-01 | P1 / S | Setup/onboarding | Missing UI; `/dashboard/setup` | Connect initial configuration, provider setup and a successful authorized request; persist setup decisions. |
| UI-02 | P1 / M | Home topology | Missing UI; `/home` currently Overview | Actual provider/route topology and state, not generic health counters. |
| UI-03 | P1 / L | Usage analytics | Partial; analytics currently `UsageReport.tsx` | Time series, filtering, grouping, comparison periods and exact token/cost dimensions from Rust queries. |
| UI-04 | P1 / M | Provider stats / utilization | Missing UI; provider-stats currently Overview | Per-account/model/provider totals, success/latency/utilization; data isolation and bounded aggregation. |
| UI-05 | P1 / L | Combo health / live view / route trace | Missing UI; combo subpaths currently Combos | Decision reasons, fallback attempts, health and live updates without leaking credentials or other tenants. |
| UI-06 | P2 / L | Search analytics and evals | Missing surface; analytics search/evals | Persist datasets/evaluation runs and search metrics; import history; reliable status/error reporting. |
| UI-07 | P1 / M | Free tiers and provider rankings | Missing UI | Quota/free-tier metadata, ranking inputs/freshness and explicit unavailable-provider handling. |
| UI-08 | P2 / L | Radar | Missing surface | Discovery/sync/recommendations, admin controls and opt-in feature flag; no automatic entitlement assumption. |
| UI-09 | P1 / L | Local embedded services | Missing surface; provider/services currently generic Providers | Durable config plus lifecycle/health/logs; bounded supervision and clean stop. |
| UI-10 | P1 / L | Media provider management | Missing surface | Separate audio/image/video capabilities and credentials, model lists, pricing and diagnosis. |
| UI-11 | P2 / L | Relay | Missing surface | Port configured relay transport/auth/routing with explicit failures and loop protection. |
| UI-12 | P1 / L | MCP endpoint and tools | Missing surface; `open-sse/mcp-server/` | Inventory tool/scopes from baseline; supported transports, authentication, isolation, cancellation and audit. No placeholder endpoint tab. |
| UI-13 | P2 / L | A2A server and audit | Missing surface; `src/lib/a2a/` | Discovery, JSON-RPC tasks, streaming, cancellation, identity/scopes and durable task transitions. |
| UI-14 | P1 / XL | Token saver / compression engines | Missing surface; context and compression APIs | Port each engine/config (Caveman, RTK, Headroom, session dedup, CCR, LLMLingua, Lite, Aggressive, Ultra, Omniglyph), limits, opt-in exclusions and accurate savings. Do not silently alter prompt semantics. |
| UI-15 | P1 / L | Compression combos/studio/live/analytics | Missing surface | Persist experiments/settings, apply pipeline, compare input/output and measured tokens; stream bounded telemetry. |
| UI-16 | P1 / L | Response/cache management and cache health | Missing surface; cache API/pages | Key construction, tenant/policy separation, TTL, invalidation, counters and inspection; never cache private traffic across tenants. |
| UI-17 | P1 / L | Media cache | Missing surface | Durable objects/metadata, limits/eviction, range/content handling and ownership-aware access. |
| UI-18 | P2 / L | Skills/catalog/prompt styles | Missing surface; `src/lib/skills/` | CRUD/import/export, version/activation, scope, injection rules and durable configuration. |
| UI-19 | P2 / XL | Conversation memory | Missing surface; `src/lib/memory/` | Persist/search/retain/delete with tenant boundaries; reproduce injection and retrieval behavior, bounded resource use. |
| UI-20 | P1 / L | CLI code integrations | Missing surface; `/dashboard/cli-code` | Configure supported CLI endpoint/model/key without credential exposure; reversible settings and connection validation. |
| UI-21 | P2 / XL | CLI agents / ACP / cloud agents | Missing surface | Inventory each adapter, durable jobs, subprocess supervision, cancellation and secret handling. |
| UI-22 | P2 / XL | Conductor / orchestration | Missing surface | Workflow DAG/task state, recovery after restart, concurrency, logs and permissions. |
| UI-23 | P2 / L | Agent bridge | Missing surface | Configured bridges, connection lifecycle, protocol mapping, access controls and diagnosis. |
| UI-24 | P2 / XL | Plugins | Missing surface | Manifest/installation/lifecycle/permissions with extension boundaries; do not execute arbitrary frontend plugins with backend privileges. |
| UI-25 | P1 / M | Pricing overrides | Missing UI; `/dashboard/costs/pricing` | Read/edit/sync pricing, currency/unit clarity, retained ledger snapshots and conflict-safe import; catalog list prices alone are insufficient. |
| UI-26 | P1 / M | Provider quota view | Partial; `/dashboard/quota` → Resilience | Restore account/model windows, auto-refresh settings and quota sharing semantics beyond shared monetary budgets. |
| UI-27 | P1 / L | Request/proxy/console logs | Partial only for usage aggregate | Bounded searchable records, request detail, redaction, retention and live tail. No infinite memory buffers. |
| UI-28 | P1 / L | Timeline / conversations / activity | Missing UI; activity currently aggregate usage | Reconstruct correlated requests/messages with permission-aware payload retention and deletion. |
| UI-29 | P1 / M | Audit log | Partial; `AuditLog.tsx`, `audit_export.rs` | Compare old filters, event taxonomy, actor/resource attribution, export; MCP/A2A tabs require those domains, not a generic audit prefix. |
| UI-30 | P1 / M | Health / runtime / connections | Partial; Overview and Resilience | Component/resource details, readiness and actual dependency failure, worker state and bounded diagnostics. |
| UI-31 | P1 / L | Generic event webhooks | Missing surface; currently aliased to usage destinations | Separate event subscriptions from usage exports; signed delivery, retries, backoff, replay/outbox and safe destination handling. |
| UI-32 | P1 / M | Log export / usage sinks / BigQuery | Partial; `UsageSinks.tsx`, `native_usage.rs`, `audit_export.rs`, `kafka_export.rs` | Verify each configured destination and delivery schema including model, key identifier, organization, tokens/costs, deduplication and retry. Usage sinks do not establish generic log-export parity. |
| UI-33 | P1 / S | API endpoint explorer | Missing UI; `/dashboard/api-endpoints` | Enumerate actual endpoints/methods/auth, examples and versioned schemas; do not advertise unsupported protocols. |
| UI-34 | P1 / M | Playground | Partial; `Playground.tsx` | Text multi-turn/stream/cancel and key-scoped model discovery exist. Still port system/generation controls, history, compare/API tabs, attachments/tool output and metrics; no browser-secret persistence. |
| UI-35 | P1 / M | Translator UI | Missing UI | Explicit source/target protocol conversion, structured errors and examples driven by actual Rust translators. |
| UI-36 | P1 / L | Search tools and web fetch | Missing surface | Provider transport/results, query/fetch schemas, credits/costs, timeouts and search-specific credential settings. |
| UI-37 | P2 / L | Traffic inspector | Missing surface | Scoped capture/filter/replay with payload retention, sanitization and bounded buffers. |
| UI-38 | P1 / M | Discovery | Partial; currently Models | Runtime capability/endpoint/key discovery already has Rust routes. Add actual explorer and distinguish metadata, configured endpoints and authorized capabilities. |
| UI-39 | P1 / L | Network / tunnels / outbound proxies | Missing surface | Persist proxy selection per connection, tunnel lifecycle, diagnostics, credential secrecy and SSRF boundaries. |
| UI-40 | P0 / M | Storage/general settings | Missing UI | Backend/data-directory visibility, backup/restore/migration status; no silent storage failover. |
| UI-41 | P1 / S | Appearance and sidebar settings | Missing UI | Theme/density/navigation visibility, persisted preferences and migration of old hidden IDs. |
| UI-42 | P1 / M | Prompt and AI settings | Missing surface | Persist/retrieve defaults and prove where they affect requests; prevent inert form controls. |
| UI-43 | P0 / L | Routing / advanced settings | Partial runtime subset | Compare every setting to legacy `/api/settings` consumers; unsupported fields must be reported during import. |
| UI-44 | P0 / L | Security settings beyond OIDC | Missing UI / partial auth | Session/API auth controls, guardrails and policy settings are distinct from OIDC. Preserve opt-in PII defaults and authorization enforcement. |
| UI-45 | P1 / M | Feature flags | Missing surface | Definitions, safe defaults, scoped overrides, runtime effects and migration. No feature declared available because its flag exists. |
| UI-46 | P2 / L | Modality bridge | Missing surface | Explicit conversion paths, supported providers, accounting and cancellation; error on unsupported combinations. |
| UI-47 | P2 / L | Chaos mode | Missing surface | Scoped fault injection with explicit opt-in, reset and observability; never enabled in production by migration. |
| UI-48 | P1 / L | Batch jobs and files | Missing surface | Upload/storage/ownership, job lifecycle, polling/cancellation, durable results and metering. |
| UI-49 | P1 / M | Docs/help links | Review | Docs must describe the actual installed product/API; issue links are links, not migrated backend features. |

## Backend features without a one-to-one menu item

| ID | Priority / complexity | Missing evidence or work | Source / acceptance |
| --- | --- | --- | --- |
| API-01 | P0 / L | Every protocol's request/response and error contracts | `src/app/api/v1/`, `open-sse/translator/`, `open-sse/transformer/` → `translation.rs`, stream modules. Golden fixtures for roles, tool calls, reasoning, structured output, token usage and all terminal stream forms. Chat, Responses, Messages, Gemini, embeddings and rerank Rust routes exist; equivalence is partial. |
| API-02 | P1 / L | Audio/TTS/transcription, image/video and multimodal routes | Compare all baseline v1 route files, media registries and executors. Current router does not expose these families. Require provider-specific multipart/binary/stream tests and accounting. |
| API-03 | P1 / L | Search/fetch, files, batches and remaining v1 protocols | Enumerate exact method contracts from the JSON inventory. No path/count-only parity claims; transformed APIs need explicit compatibility mapping. |
| API-04 | P0 / XL | Provider transport/auth coverage | Inventory all old executor files (included in JSON), then map provider→auth→endpoint→protocol→model normalization→fallback→quota. `product_provider.rs` explicitly implements a narrow compatible-chat subset. Generic base URL support is not a native provider port. |
| API-05 | P0 / L | Legacy field compatibility and unsupported-policy migration | `legacy_keys.rs` rejects nonempty unsupported fields; `product_combo.rs` has narrower legacy semantics. Record each rejected field and implement before lifting rejection. Disabled imports and archived tables do not fulfill live parity. |
| API-06 | P1 / L | Guardrails/hooks/PII/security policy | `src/lib/guardrails/`, middleware registry, policy code. Tenant/realm isolation, deterministic order, opt-in data mutation and streaming correctness. |
| API-07 | P1 / L | Pricing/dynamic provider metadata refresh | Preserve request-time price snapshots, custom overrides and source provenance; catalog refresh must not change entitlements or retroactively rewrite costs. |
| API-08 | P0 / L | Data-domain completeness | All DB modules/migrations are enumerated in JSON. For each populated domain choose live migration or explicit unsupported blocker. Require idempotent import, counter reconciliation and rollback evidence; never silently discard. |
| API-09 | P0 / L | Durable side effects and background workers | Outbox reservation/delivery, cleanup, refresh, reconciliation and supervision; replay/restart/concurrency tests across two processes sharing SQLite. |
| API-10 | P0 / M | Measured latency, memory and concurrency | Compare old/new at same workload, provider stub and machine: cold/warm memory, TTFT, p50/p95/p99, throughput, slow clients, cancellation, long streams. Use existing CI performance suite; frontend completion does not prove performance. |

## Execution order and release gate

1. **Inventory and truthful baseline**: this backlog plus all 106 surfaces, 803 API files,
   executor/service/DB inventories. Keep this list updated in feature commits. This is
   a static audit, not a completed behavioral audit of 803 routes.
2. **Core replacement**: CORE-02/03/05/09/10 first, then CORE-04/06/07/08/11/12.
   Work by vertical slice: real Rust contract, durable state, working SPA, import
   mapping, regression tests. CORE-01 evolves with those slices.
3. **Proxy completeness**: API-01 through API-07, then observability, logs,
   pricing, settings, network, search/media/batch, and all remaining P1 rows.
4. **Additional product subsystems**: compression/cache, MCP/A2A, skills/memory,
   agents/orchestration/plugins/Radar and remaining P2 rows. They remain required
   for the user's requested full parity; core usability is not final completion.
5. **Cutover sign-off**: all relevant rows carry a tested implementation and migration
   result; no unexplained legacy settings/tables; CI passes for the exact commit;
   installed SPA exercises production Rust APIs; provider credential smoke and
   representative parallel workload measured; persistent local instance upgraded
   without loss; backup/rollback rehearsal complete.

## Slice started from this audit

CORE-02: restore model-catalog filtering, sorting, bounded pagination and detailed
metadata through the existing authenticated Rust catalog API. This closes an
identified UI gap without creating another backend. Global cross-provider search,
configuration/entitlement links and the rest of the row remain open until separately
implemented and validated. CI results belong in the delivery report; a source change
or a mock UI test alone does not certify the whole catalog or a live provider.
