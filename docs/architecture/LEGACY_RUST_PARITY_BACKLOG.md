# RedRouter backend and dashboard parity backlog

Audit date: 2026-11-12. Legacy baseline: `525a71de4ac25968d0a25e52eeb1b09cc21c6e92`
(v0.60.5, last first-parent main commit as of 2026-10-29). The newer main commits
through 2026-11-08 concern CI. This is our product baseline, including its inherited
capabilities, not a new comparison against today's upstream feature lists.

**The port is not complete.** There are 15 SPA pages versus 106 historical navigation
surfaces across 33 groups and 8 areas. 69 historical surfaces have no SPA route;
35 resolve to a page but need behavioral review; 2 are external links. None of those
counts is a feature-completion percentage. There are 803 legacy API route files and
86 registered Rust paths. Renamed/consolidated APIs must be traced, not automatically
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

Provider configuration now has a [32-item field-level expansion](LEGACY_PROVIDER_PARITY_FIELDS.md), covering node definitions, accounts, transport settings, model overrides and migration gaps. The [executor audit](LEGACY_EXECUTOR_PARITY.md) separately enumerates 142 legacy aliases across 81 source-module groups; none is accepted as complete by name or catalog presence.

## Core replacement: first execution wave

| ID | Priority / complexity | Capability and current state | Legacy evidence → new implementation | Remaining work and acceptance |
| --- | --- | --- | --- | --- |
| CORE-01 | P0 / M | Rail, panel, tabs, deep links — Partial | `src/shared/constants/sidebarNav.ts`, `src/shared/components/shell/` → `rust-dashboard/main.tsx`, `routes.ts` | Restore the original 8-area taxonomy, entry tabs, breadcrumbs, search, visibility and mobile navigation as their features land. Do not expose dummy actions or count aliases as ports. Deep-link and keyboard E2E. |
| CORE-02 | P0 / M | Model/provider catalog — Partial | `src/app/(dashboard)/dashboard/models/`, `src/lib/catalog/` → `catalog.rs`, `ModelCatalog.tsx` | Global/provider/type search, sorting, pagination and full capability/context/cache-price metadata are implemented; verify CI evidence below. Remaining: model/configuration links and complete freshness/retry parity. Distinguish listed metadata from configured/authorized providers. Bound rendering and avoid stale results after changing provider. |
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

2026-11-13 — CORE-05/09: legacy key import now translates access schedules into
the native schedule table, retaining enabled/disabled state, IANA timezone,
overnight windows and empty-day deny-all schedules. The native validator and SPA
accept the latter without turning an empty day list into unrestricted access.
Malformed/unknown schedule fields still roll back the complete key import.
Keys remain disabled pending quota adoption/activation. Added storage-reload and
HTTP authentication regressions plus invalid-schedule rollback cases; CI evidence
must be checked for the feature commit before accepting this slice.

Field review found another migration dependency: legacy model permissions expand
provider aliases and distinguish `restricted + []` from allow-all. The latter now
has an explicit mode in native storage, issue/update/list APIs, runtime policies
and SPA editing. Missing mode on an existing-key update preserves its restriction;
nonempty lists always restrict access even if a caller marks them `all`. Restricted
empty keys can now be imported (still disabled pending quota reconciliation). Tests
cover database reload, denied inference/catalog, metadata edits, blocked-model
precedence and transactional import rollback. CI must verify the delivery commit.
At this stage nonempty legacy allow/deny lists were still blocked; the versioned
matcher slice below addresses that dependency. CORE-05/09 stay open.

CORE-02: restore model-catalog filtering, sorting, bounded pagination and detailed
metadata through the existing authenticated Rust catalog API. This closes an
identified UI gap without creating another backend. Global cross-provider search is addressed by the later slice below.
Configuration/entitlement links and the rest of the row remain open until separately
implemented and validated. CI results belong in the delivery report; a source change
or a mock UI test alone does not certify the whole catalog or a live provider.


2026-11-13 — CORE-05/07/09: separate per-key combo grants from direct model
permissions. Legacy `apiKeyPolicy.ts` and `chat/comboTargetKeyPolicy.ts` explicitly
permit named combos independently of direct model lists, including `restricted + []`.
This is a distinct permission domain, not proof that the model wildcard engine is ported.

- Native storage/API/SPA now preserve null (existing model-based behavior), an empty
  explicit list (deny all combos), named grants and `combo/*` (all combos).
- Explicit grants authorize curated combo targets independently of model allow/deny
  lists, matching the old product. Provider, organization, endpoint, schedule, key
  activation and quota restrictions still apply. `auto/` targets retain model checks
  when there are actual model allow/deny entries.
- Catalog filtering uses the same combo/target decision as dispatch. Historical
  `combo/name` requests resolve to the durable combo ID before routing state is used.
- Import preserves named/empty/all combo lists. The initial empty-policy importer translated absent combo lists into `combo/*`.
  The versioned matcher below supersedes that translation and preserves null exactly,
  including its behavior after later edits.
- Tests cover grants versus blocked models, metadata edits, explicit reset, provider
  and endpoint denial, RPM limits, catalog/dispatch agreement, source preservation
  and complete rollback on an invalid later key. Browser edits exercise separate
  model/combo selectors and preserve disabled schedules. Final CI remains required.

Group policies and auto-combo controls still need translation. Nonempty legacy
model allow/deny lists are addressed by the versioned matcher below. These rows remain partial; no full key/combination parity claim.


2026-11-13 — CORE-05/06/09: client-key records and their six policy sidecars now
commit in one SQL transaction. SQL readers use one joined statement so concurrent
writers cannot expose a key from one commit with permissions/ownership/quotas from
another. Missing sidecars retain pre-migration defaults; present sidecars with a
mismatched revision still fail closed. This removes six SQL round trips per key
snapshot while retaining the indexed merge for the RedDB paths.

New SQLite regressions inject a failure at the final write and verify rollback of
both updates and inserts, exercise independent writers plus a reader against the
same file, and check compatibility with pre-sidecar records. This is atomic policy
persistence, not compare-and-swap editing: simultaneous full replacements still use
last-commit-wins semantics. RedDB writes remain version-checked sequential writes;
this change does not claim transactional or multi-replica parity for that backend.


2026-11-13 — CORE-05/07/09: port legacy nonempty model permission lists with
versioned matching, rather than reinterpret them as native patterns. The imported
allow-list JSON carries its schema and the effective Claude-Code routing preference;
native arrays keep their existing semantics. API responses expose normal lists, and
SPA edits preserve the matcher on the server. The UI explains imported wildcards
without exposing backend implementation labels.

- Match exact names, segment globs, literal trailing `/*` across nested names,
  provider canonical/public/historical aliases and `[1m]` context suffixes. Legacy
  standalone `*` still does not cross `/`; the existing native universal `*` is unchanged.
- Alias snapshot comes from the unchanged registry at baseline `525a71de4ac2`,
  regenerated by `scripts/research/legacy-model-aliases.ts`. This is permission
  compatibility data, not evidence that all provider transports are implemented.
- Preserve deny precedence, explicit combo grants, automatic-combo target checks,
  null combo grants with model restrictions, and allow-listed combo names. Catalog
  and dispatch check provider-qualified targets with the same policy.
- Import reads the persisted `preferClaudeCodeForUnprefixedClaudeModels` boolean,
  falling back to the original `OMNIROUTE_PREFER_CLAUDE_CODE_FOR_UNPREFIXED_CLAUDE_MODELS`
  environment flag. Operators must carry that source environment into offline import
  when the preference was not persisted. The resolved preference is frozen per imported
  key; a future routing-settings UI must explicitly migrate it rather than silently
  reinterpret saved grants. Invalid settings or lists roll back all keys.
- Existing limits (128 patterns, 256 bytes each) remain explicit import blockers for
  larger source lists. Groups, non-public visibility, disabled-model settings and
  other unsupported fields remain blocked. Keys still
  require quota adoption before activation. This is not complete key migration.
- Added matcher tests, source-preserving import/reload, catalog/dispatch denial with
  provider-call counting, policy-edit round trips and browser form regressions.
  Acceptance requires CI for this commit; no tests were run locally.

The preceding atomic-write CI exposed SQLite write-lock contention under the Windows
embedded-feature job. SQLite connections now enable WAL, key writes acquire their
write transaction with `BEGIN IMMEDIATE`, and acquisition retries only SQLite busy/
locked errors (three attempts, existing five-second busy timeout). PostgreSQL retains
normal transactions. A pinned-reader regression verifies that a writer commits while
the reader retains its original snapshot; the independent-writer regression remains
unchanged. No constraint/IO/commit error is blindly retried and no durability pragma
is weakened. The failed run is `43382264010`; replacement CI must verify the fix.

2026-11-13 — CORE-05/09: migrate legacy `allowed_connections` to native
`allowed_provider_ids`. `src/sse/services/auth.ts` applies an exact connection-ID
allow-list, with null/empty meaning unrestricted; the native provider gate has the
same semantics and provider adoption preserves IDs. Keep dangling identifiers
instead of dropping the list and widening access. Invalid/mixed-type/wildcard lists
and lists exceeding 128 entries roll back the import. The synthetic `noauth` ID is
preserved as an ID, not expanded into a wildcard or treated as a configured transport.

The migration regression now configures two accounts of the same provider and proves
that the imported key only dispatches through its permitted account; the other account
is also absent from the client model catalog. Edits/reload retain the grants. This
does not port exclusive account leases or the separate scopes controlling those leases.


The versioned matcher applies to **every newly imported key**, even an initially
empty model policy. Null combo grants remain null instead of being converted to
explicit all-combo grants. This matters after an administrator adds restrictions:
legacy inherited target checks must then apply, and `*` must retain its source
meaning. A regression edits a previously unrestricted imported key and verifies both
properties. Older imports created by the earlier empty-policy importer cannot be
unambiguously reinterpreted from destination fields alone; re-import from the preserved
source is needed to distinguish originally null from explicit `combo/*`.


2026-11-13 — CORE-02/UI-38: authenticated global models.dev catalog search now
uses `GET /api/admin/model-catalog/search/models`. The SPA's All providers option
submits filters/sorting and pages of 50; provider-qualified row identity keeps the
same model ID from different commercial deployments distinct. Metadata search is
not model entitlement and does not create providers, keys or routing grants.

The API bounds page size to 100 and query length to 256 bytes, pins pagination to
the snapshot hash when supplied, and returns stable provider/model tie-breaks.
Missing price/context values sort last rather than becoming free/zero. Searches
run in at most two blocking workers, retaining their permits through client
cancellation. They retain lightweight candidate references and parse only returned
metadata again for serialization; they do not fill all lazy provider caches or send
the entire catalog to the browser. This is bounded concurrency, not a latency or
memory benchmark claim.

Regressions cover source-wide filtering, duplicate IDs, page boundaries, stale
snapshots, cache laziness, unknown prices, unauthorized API calls, browser pagination
and recovery after a failed search. The general CI also found an unescaped apostrophe
in Playground JSX; it is corrected here. Acceptance still requires the exact commit's
CI and local deployment verification.


2026-11-13 — CORE-03 / PV-16: native API-credential connections now support
bounded custom request headers via a names-only read API and an encrypted replace
operation. The SPA exposes the editor when editing a saved API connection. Values
are not returned or included in audit snapshots. Destination identity binding stops
an endpoint change from forwarding old values elsewhere. Runtime snapshots carry
validated sensitive header maps through direct requests, combo attempts, internal
summary/fusion calls and diagnostics; SQLite is not queried per inference request.
The canonical legacy auth/framing/forwarding denylist is preserved. New tests cover
persistence, diagnostic/dispatch use, combo use, secret redaction, clear/reload and
invalid input. The header integration passed in CI runs 43394672400 and 43396546986; the latter
completed the main storage/proxy test step. Full-suite follow-up is still running.
Legacy custom-node import, OAuth custom headers and per-model overrides remain open. Also corrected the global catalog E2E
fixture to establish its admin session rather than timing out on the login screen.


The new header convergence regression exposed a SQLite watcher defect: PRAGMA
`data_version` was read from the single-connection writer pool, so its own commits
were invisible to another control-plane instance sharing that pool. The watcher now
owns a separate query-only physical connection, retains pending changes until both
snapshots acknowledge them, and leaves the writer slot available. A focused regression
checks repeated writes/deletion through the same pool and the observer's read-only
boundary. The focused observer regression and header convergence passed in CI. In-memory
SQLite retains signature polling because a separately opened memory database would
not observe the original state. OAuth lease assertions remain unchanged.

2026-11-13 — PV-01: connection labels now retain the legacy 200 UTF-16-unit limit
in native CRUD, SPA editing/session import and API/OAuth data migration. The earlier
128-byte restriction rejected valid existing names, especially Unicode. Regression
fixtures now import full-length names without truncating them; no credential,
activation or unsupported-setting checks were relaxed. Validation of this slice is
tracked separately from the broader provider configuration gap.

2026-11-13 — PV-18 / CORE-03: saved API connections now expose native model
discovery configuration (GET/PUT) and probing (POST) at
`/api/admin/providers/{id}/discovery`. A custom path is durable in the selected
storage backend; null restores the path inferred from known inference endpoints.
The SPA edits it, queries saved credentials/headers, searches/pages the returned
models and selects a model for the existing connection diagnostic. OAuth/CLI
connections retain their own discovery contracts and are not guessed here.

Probes reuse DNS pinning, private-address policy and resolved auth headers, prohibit
redirects, and encode pagination cursors on the original origin. Gemini token and
Anthropic cursor pagination have cycle/page/total-body/model limits; failures do not
silently return a partial list. There is no network or storage query added to the
inference hot path. Catalog metadata is not replaced and discovery does not grant
model access or create routes. Reusable node definitions, node inheritance/import,
custom-model mutation and routing aliases remain open. CI must validate this slice.

The discovery UI regression suite passed (225 UI tests, run 43402203339), as did
product checks (43402198768). The Rust run exposed an undersized admin key in the
new isolation fixture; it is corrected and requires another full run. The preceding
run also exposed a second OIDC test assumption (absolute lifetime JWKS count after
restart); it now verifies exactly one additional fetch, independent of legitimate
unknown-key refreshes before restart. SQLite startup avoids setting journal mode
again when already in WAL and logs a non-sensitive setup phase on connection failure;
this is not yet proof that the intermittent pool timeout has been eliminated.

Credential KDF work in native control-plane HTTP, OAuth, snapshot reload, discovery,
headers and managed export setup now runs on bounded blocking workers. Inference
concurrency is independent. The scrypt parameters, ciphertext format, identity
binding and zeroization are unchanged. Cancellation keeps the worker permit with
its running job so abandoned requests cannot exceed the cryptographic memory bound.
A current-thread runtime regression checks that another request progresses during
encryption. CI must verify the changed asynchronous call paths and concurrency.


2026-11-13 — discovery/credential-worker validation: full Rust run **43404019368**
passed, including Linux data plane, Windows storage, embedded storage, FastLLM
concurrent-agent fixture and performance gates. Product checks **43402198768** and
225 UI tests **43402203339** passed. This validates that slice, not full parity or
real-provider interoperability; intermittent failures require ongoing observation.

PV-18 now also has a persisted explicit native API protocol, enabling custom
inference paths in the SPA and backend. Legacy clients retain URL detection;
metadata edits preserve saved configuration. Revision-bound transport metadata is
loaded with provider snapshots, not per inference request. Changes require renewed
credentials and reject incompatibility with enabled direct or nested combos before
writing. Header identity includes an explicit protocol, while old `auto` bindings
remain compatible. Tests added for URL security, custom dispatch/diagnostics,
combo protection, credential preservation, fresh-process reload, disable/purge and
SPA editing; CI for this addition is pending. Reusable node definitions, inheritance,
legacy node import and custom model/alias management are still unported.


The custom-protocol SPA has passed UI run **43406962517** and product checks
**43406957810** (source `6ccb581b4`). Follow-up fixes also reject disabled provider
edits while an enabled combo depends on them, avoid adding protocol-history rows
for auto-detected OAuth transports, and restrict environment bootstrap to an empty
provider table. A process regression now exercises custom-path bootstrap, restart
with conflicting seed values, disable and restart without reactivation. These
follow-ups still require the next complete Rust CI run.

Local preview now runs backend `c4a908434` with dashboard `6ccb581b4`, preserving
SQLite via a backup before activation. Health and SPA serving return 200; the
unauthenticated management API returns 401. This is local preview availability,
not proof of real-provider access or completed migration.

Performance evidence from successful Rust run **43404019368**: 200 fixture
requests at concurrency 16 measured p95 1.768 ms for the SQLite product connection,
2.930 ms with dashboard policy, 7.485 ms for dashboard combo primary and 10.007 ms
with fallback. Shared RPM measured p95 27.587 ms. These are synthetic CI scenarios,
not provider latency, production SLOs or a fresh Next-versus-Rust comparison.


2026-11-13 — protocol run **43406953586** completed successfully, including all
Rust, Windows, embedded and performance stages. Native provider definitions are the
next PV-17/18 slice: tenant-scoped CRUD, separate account credentials, revision-bound
bindings, inherited endpoint/protocol/model-discovery settings and SPA selection.
Shared endpoint changes require explicit operator intent and validate account auth
and enabled-combo compatibility before persistence. Namespace uniqueness is enforced
in SQL; cross-tenant update/delete guards are enforced in storage. Removal refuses
linked accounts, including disabled ones. API/SPA regressions cover dispatch,
discovery, credentials, namespace collisions, tenant scope, confirmation, compatible
shared updates and restart; this slice and the preceding startup follow-ups need CI.

This does not close shared definition headers, presets, legacy node migration,
custom models or model-prefix routing aliases. Distributed binding/create/delete
races and non-SQL namespace uniqueness remain explicit acceptance gaps. A binding
whose definition disappears fails closed rather than sending credentials to a
fallback destination. The 71-front backlog remains open.


Provider-definition slice `6fa261d6d`: product checks **43410126192** and all
**227 UI tests** (**43410130312**) passed. Rust run **43410122205** and real-SPA
browser run **43410984355** are pending. The browser regression creates a definition,
binds an account, reloads durable settings, rejects an unconfirmed shared endpoint
change and verifies an approved change after reload. The local preview now runs
backend and dashboard `6fa261d6d`, with a SQLite/executable backup, HTTP 200 for SPA
and health, authenticated definition listing, and 401 without authentication.

Packaging review corrected both source Dockerfiles to copy compile-time catalog
and provider-namespace JSON inputs and invalidate the temporary dependency-cache
targets before compiling real sources. A full source Docker image build has not yet
been established by the current checks; native build/browser evidence is narrower.


2026-11-13 — real SPA browser run **43410984355** passed, including creation of a
reusable definition, account binding, persisted reload and confirmation of a shared
endpoint update. Rust run **43410122205** has passed main tests, Windows, FastLLM,
embedded storage and lint; release/performance completion is still pending.

PV-16/17: encrypted shared header defaults now live in the definition document,
with names-only GET/PUT management and the SPA editor. Account values override
matching names; removing overrides reveals shared defaults. Both sets detach on
transport identity changes. A bounded per-control-plane cache avoids repeating
scrypt for every linked account and refreshes by encrypted revision. Definition
metadata updates preserve ciphertext; public node responses use an explicit allowlist.
Revision-checked writes reject stale changes and cannot resurrect deleted nodes.
Tests extend two-connection precedence, diagnosis/discovery/combos, restart,
cross-instance removal, corruption, owner isolation and simultaneous writers.
Validation for shared headers is pending; legacy node import remains open.


2026-11-13 — PV-22: explicit no-auth upstream connections now accept an empty
credential through authenticated management APIs and SPA. Inference (including
streaming/combos), diagnostics and discovery omit upstream authentication headers;
client-key checks, destination validation and OAuth requirements remain intact.
SQLite restart, client-key rejection, mode transitions and credential non-forwarding
have CI regressions. Audit records distinguish an encrypted envelope from an actual
credential. Legacy import and duplicate replacement are still open; this is not full
PV-22 acceptance. Validation pending for this slice. Shared header UI/checks at
`86d217044` passed; its Rust suite and browser coverage remain in progress.


2026-11-13 — validation follow-up: shared definition headers at `86d217044`
passed [the full Rust suite](https://github.com/reddb-io/red-router/actions/runs/43413305187),
including storage/restart, concurrent write rejection, embedded RedDB opt-in,
Windows, all-features lint, FastLLM fixtures and benchmarks. Shared header browser
save/reload/detach/remove passed at `2af7463f1`. The latest provider no-auth / legacy
policy refusal code (`444aded25`) passed
[product checks](https://github.com/reddb-io/red-router/actions/runs/43416237406) and
[229 UI tests](https://github.com/reddb-io/red-router/actions/runs/43416242737).
[Its Rust run](https://github.com/reddb-io/red-router/actions/runs/43416650151) is still
active. The no-auth browser test encountered an exact-label locator timeout (12
other browser tests passed); `84b405406` fixes the locator and
[the browser rerun](https://github.com/reddb-io/red-router/actions/runs/43417518373)
is pending. These are fixture results, not real-provider or full-port acceptance.
