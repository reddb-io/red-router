# Rustify migration queue

This is the operator-facing completion ledger for replacing the historical
Next.js backend with the Rust server and static SPA. It is ordered exactly by
the requested product priorities. A row is complete only when its behavior,
existing-data migration, SQLite persistence, SPA/API contract and repository CI
have all passed. File counts and Rustify candidates are discovery evidence, not
completion percentages.

Baseline: legacy `525a71de4ac25968d0a25e52eeb1b09cc21c6e92`; Rustify
`bbf9ac726e4fbf511a77a4c9e818cd8fb7f9bcb7`. The detailed dependency graph and
71-front audit remain in [RUSTIFY_PARITY_AUDIT.md](RUSTIFY_PARITY_AUDIT.md). The Rustify port plan, graph sizes and phases are in
[RUSTIFY_ROADMAP.md](RUSTIFY_ROADMAP.md).

| Order | Requested capability | Complexity | State | Current acceptance gap |
| ---: | --- | --- | --- | --- |
| 1 | Reusable compatible providers, custom paths and model discovery | Medium-high | **In progress** | Native definitions, account bindings, encrypted headers and authenticated discovery exist. Definitions keep an optional icon validated like the legacy `iconUrl.ts` (http(s) or `data:image/*;base64`), editable through the admin API and imported from legacy nodes (local clippy and tests, 2026-11-19). SQLite discovery persists connection-scoped inventories and exposes them to eligible client keys; its full Rust CI is pending. Catalog membership does not prove account entitlement. Account selection, adoption of legacy inventories, remaining presets/media variants and full cutover remain open. |
| 2 | Custom models, aliases, context limits, capabilities and parameters | Medium-high | **In progress** | Custom metadata and aliases exist. Alias-aware reservation, settlement and operator reconciliation retain both the public name and actual upstream model transactionally and passed the full Rust/product gates. Offline import handles a supported subset of custom models and exact aliases transactionally; verified OpenAI-compatible custom-node aliases also import and route through two instances (Rust CI 43505779409). Single-target array and provider/model object forms now import without dropping additional fields (CI pending). Glob aliases (`settings.wildcardAliases`) now import and resolve after exact names, most specific pattern first, for names without a provider prefix, as in the legacy resolver (Rust CI 44429721753). Provider-scoped aliases (`providerAliases`), which the legacy router writes but never reads at request time, are staged verbatim in `redrouter_legacy_provider_alias_records` (Rust CI 44434486863). Managed aliases import as ordinary aliases, and their provenance markers (`managedModelAliasNames`) are staged in `redrouter_legacy_managed_alias_names`; the legacy model sync that generates and prunes them is not ported (Rust CI 44434486863). Per-model upstream headers (legacy `upstreamHeaders`) are stored encrypted and write-only through `/api/admin/provider-models/{id}/headers` and override the account's custom headers on combo, alias and `provider/model` targets and, per client protocol (`openai`, `openai-responses`, `claude`), as `compatByProtocol` does (Rust CI 44439037093). The model importer now carries legacy `modelCompatOverrides` headers over, encrypted, onto the model's visibility record or a headers-only record that changes neither metadata nor visibility; it drops the names the legacy sanitizer never sends and refuses credential headers, other compatibility flags and imports without the storage key (Rust CI 44442685134). A custom row's own headers import with it and win over compatibility entries, as in the legacy reader (Rust CI 44446191930). The `normalizeToolCallId` flag (model-wide or per client protocol) is now a model compatibility setting that rewrites a Chat Completions body's tool call IDs to nine characters and relinks the tool responses, and it imports from compatibility entries and custom rows (Rust CI 44450626536); the IDs are derived from the client's IDs instead of random. Chat Completions requests to a known provider now get the legacy role normalization (`roleNormalizer.ts`): `model` becomes `assistant`, `developer` becomes `system` unless the provider is OpenAI-family or the model's `preserveOpenAIDeveloperRole` keeps it (the OpenAI-format filter below then maps it for Chat Completions targets anyway, as in the legacy pipeline), and system content folds into the first user message for providers and models without a system role (Rust CI 44454779365); for providers that reject a non-first system message (`mimo`, `xiaomi-mimo`, `tokenrouter` and `OMNIROUTE_STRICT_SYSTEM_PROVIDERS`), later system messages merge into one leading message (Rust CI 44457860537), and GLM-family requests without a `user` turn get the legacy `(continue)` placeholder (Rust CI 44461288857). The `preserveVideoUrl` flag now decides whether Moonshot's `video_url` blocks reach an OpenAI-format upstream, kept by default only for Moonshot and Kimi (Rust CI 44454779365). The rest of the legacy `filterToOpenAIFormat` now applies to those requests: `developer` becomes `system` for every Chat Completions target whatever the role flag, only standard content blocks survive, thinking blocks become `reasoning_content`, text-only files and tool results are inlined as text, empty turns and Claude-only fields (`metadata`, `anthropic_version`, `client_metadata`) are dropped, `max_output_tokens` becomes `max_tokens`, and Claude and Gemini tools and tool choices take the OpenAI shape; tool-turn `reasoning_content` and echoed assistant fields are stripped except for reasoning-replay providers, detected by the legacy provider list and model patterns without the registry's `interleavedField`, and `cache_control` survives only for Claude Code clients on providers that honor OpenAI-format breakpoints, in the `auto` cache mode without per-connection overrides (Rust CI 44512791786). Tool schemas are then sanitized as by `coerceToolSchemas` and `sanitizeToolDescriptions` (Rust CI 44512791786). Requests that reach the active provider without a routed target now get the same rules and the operator payload rules, without per-model flags, and fusion panel members get them too (local clippy and tests, 2026-11-19). The legacy tool-call integrity pass runs before and after those rules: every call gets a type, string arguments and an ID (derived when the client sent none), unidentified tool responses take those IDs in order, a tool-calling turn whose next message carries none of its results gets empty ones, and results whose call is gone are dropped (local clippy and tests, 2026-11-19). A Claude-style `thinking` block is dropped unless the user spoke last, and replay providers get the legacy reasoning pass as it behaves on a cache miss: `reasoning` stands in for missing `reasoning_content`, MiMo and the opencode gateways get the placeholder, the rest get no field (local clippy and tests, 2026-11-19). The response-side reasoning cache, the thinking-budget modes and the global cache-control setting are open. The custom-model importer now accepts `supportsVision` (true becomes text+image input modalities, which the catalog advertises as vision) and `isFree` (read only by the legacy `hidePaidModels` filter, which the key importer refuses when enabled, so it is validated and dropped), and skips rows the legacy model sync wrote (`source` `auto-sync`, `api-sync` or `imported`), which the cutover keeps in its raw model-visibility staging instead of refusing the import (local clippy and tests, 2026-11-19). Bare model names without a combo or alias now get the legacy provider inference (`resolveModelByProviderInference`) over a snapshot of the static registry model index (`scripts/research/legacy-model-providers.ts`, 1476 models) and the synchronized account catalogs, and compile a direct route for the inferred provider when it has accounts and no operator-selected active provider exists; ambiguous and unknown names keep the previous path, the Claude Code preference comes from the setting imported keys carry or the legacy environment flag, each account's default model replaces the inferred one for a bare request as in the legacy `resolveBareModelToConnectionDefault`, and the live-catalog reconciliation is not ported (local clippy and tests, 2026-11-19). Prefix stripping and unsupported model overrides still block cutover. Operator payload rules (legacy `payloadRules`: `default`, `defaultRaw`, `override` and `filter` by model glob and protocol) are stored globally through `/api/admin/payload-rules` and applied to the translated body of routed targets (Rust CI 44454779365); the offline cutover imports `settings.payloadRules` normalized, accepts an identical repeat and refuses different destination rules (Rust CI 44457860537), while a legacy rules file used only without database rules is not seen. Add the remaining equivalent behavior and import, and complete routing/accounting proof. |
| 3 | Account priorities, groups, default model and provider queues/limits | High | **In progress** | Account priority and default model persist with provider revisions, are editable in the SPA, import from compatible API-key and supported staged OAuth accounts, and apply to alias account pools. Rust CI 43495427853 and UI CI 43495427813 passed. Direct `provider/model` routing selects tenant-scoped account pools with fill-first fallback, policy checks and native usage accounting; Rust CI 43505779409 passed with 16 concurrent mock-upstream requests (p50 0.662 ms, p95 0.720 ms; not a live provider). Bare non-alias requests inferred onto an account pool take each account's default model, as the legacy `resolveBareModelToConnectionDefault` does, and an account's concurrency cap (legacy `max_concurrent`, 1-1000) persists with its revision, is editable through the admin API, imports from legacy connections and makes routing skip the account while it is at capacity (429 when every target is) (local clippy, storage/importer tests and a control_plane dispatch test, 2026-11-19). Complete discovery, provider strategies, groups, the legacy request queue (wait budgets, learned limits) and PV-06..09 admission without a global agent cap. |
| 4 | OAuth/CLI per executor | High | **Partial** | Codex, Claude and Antigravity staged adoption preserves per-account model exclusions with validated session identity and priority. Codex workspace and Claude organization metadata are retained in the encrypted session; Rust CI 43560995260 passed. Codex accounts with enabled per-account model auto-sync are refused until that scheduler is migrated. xAI and Openference staged adoption preserves tokens, identity, scope and exclusions offline; refresh and routing were verified with mock providers in Rust CI 43554993321 and 43558501812, respectively, not live accounts. GitHub Copilot staged adoption, mocked refresh and routing passed Rust CI 43559321898. Manual Copilot and Openference account model discovery and OAuth origin checks passed Rust CI 43562515293, and the discovery UI passed CI 43562795425. GitHub adoption refuses auto-sync and separate GitHub refresh-token flows. Port and verify remaining executors independently, including refresh/revoke and terminal account state. |
| 5 | Faithful migration of credentials, policies, configuration and counters | High | **Partial / cutover blocker** | Strict transactional importers exist but deliberately refuse unsupported populated fields. Closed refusals (local clippy and tests, 2026-11-19): provider node icons and daily quota reset clocks import with their nodes; custom-model `supportsVision` and `isFree` import, and rows the legacy model sync wrote are left to the raw staging; a key's `max_requests_per_minute` and `max_requests_per_day` become its native request limits, and quota adoption keeps the lower of that and the quota table's `rpm_limit`; a key's `allowed_endpoints` keeps its `chat`, `embeddings` and `rerank` categories (`models` has no native gate; a list without a native category stays refused); a compatibility entry's `hiddenModalities` imports its chat decision even when it names other modalities; a provider connection's health carries over as native availability (an expired, credits-exhausted or banned `test_status` becomes the matching terminal state, a future `rate_limited_until` becomes a cooldown with the legacy `backoff_level`, past cooldowns and last-error diagnostics are cleared like the legacy startup sweep); a connection's `max_concurrent` becomes its native concurrency cap; a connection's `global_priority` is validated and dropped, since the legacy dashboard shows it only as a badge and no legacy routing path reads it; a key's `no_log` imports, since the native gateway persists no request or response body for any key (any payload logging added later must honor a per-key opt-out); a key's `auto_resolve` is validated and dropped, since no legacy routing path reads it; a key's prompt-compression and semantic-cache opt-outs (`compression_enabled=0`, `cache_default_mode=bypass`) import, since the native gateway has neither feature (both must honor a per-key opt-out if added); a key's `catalog_scope` and `allow_auto_combos` become its native catalog policy, which shapes its `/v1/models` listing without changing routing (local clippy, importer, storage and control_plane listing tests, 2026-11-19); a key's `disable_non_public_models` restricts dispatch and listing to the tenant's published models (synchronized or custom, not hidden), admitting combos granted by name (control_plane test, 2026-11-19), and is stricter than the legacy gate until the Claude Code wildcard exception and effort-variant base resolution are ported; a key's `ip_allowlist` is validated and dropped because the legacy router never enforced it (no request path reads it), so imported keys keep exactly the legacy access; a key's custom `rate_limits` rules on the 60-second and one-day windows become its native request limits (strictest rule per window; other windows stay refused); a key's `max_sessions` and `throttle_delay_ms` become its native runtime limits (chat session cap with the legacy session fingerprint and 15-minute idle expiry; per-request delay up to five minutes; control_plane test, 2026-11-19); `stream_default_mode=json` imports because it only differs from the default on source formats the native gateway serves with an explicit stream signal. Still refused: management `scopes` (front 6), per-model `apiFormat`/`targetFormat`, spending windows and the other key behaviors listed in `legacy_keys.rs`, provider proxy settings, `rate_limit_protection`, `health_check_interval`, quota-window and rate-limit overrides, account groups and the OAuth-specific fields in `legacy_providers.rs`, and `stripModelPrefix`. Close each remaining refusal, rehearse backup/import/restart/rollback and preserve ciphertext, ownership and counters. |
| 6 | Organizations, permissions, OIDC and key provisioning | High | **Partial** | Tenant/OIDC/key primitives exist. Complete roles/memberships, external identity provisioning and two-tenant denial/expiry/revocation coverage. |
| 7 | Quotas, concurrent reservations, combos, fallback and resilience | High | **Partial** | Native accounting/reservations/combos/breakers exist. Alias-model admission, settlement and operator reconciliation passed without replacing actual-model attribution. Failure classification follows more of the legacy `checkFallbackError` (local clippy, unit tests and the cooldown, model lockout, breaker and quota control_plane tests run one at a time, 2026-11-19): the credit and ban signal lists match the legacy ones, a retired model (404/410) locks that model for 24 hours, a moved endpoint parks the connection for 24 hours, a billing suspension counts as exhausted credits, and daily-quota or TPD text cools the connection down until the upstream reset hint, the node's daily reset clock (`dailyQuotaReset.ts`, with DST handling) or the host's next midnight, applying to a 429 only for OAuth accounts or long-period quota bodies. The automatic 402/429 scope follows the legacy `hasPerModelQuota` (passthrough, local, self-hosted and compatible providers lock the model; snapshot of 168 providers), and a shared-wallet 402 from Grok Build, grok-web or xAI OAuth exhausts the account under any scope (`sharedWalletCredits.ts`; local clippy, unit tests and ten 402/429 integration tests run one at a time, 2026-11-19). `accountFallback.ts` itself sits in a 261-file dependency cycle, so its leaf submodules are ported first. Known divergence: the legacy operator `modelLockout` settings (enabled, error codes, base and max cooldown, backoff steps) also cap connection cooldowns (`cooldownCap.ts`, default 30 minutes, 5 s to 1 h), while the native ceilings are fixed (5 minutes per connection, 10 per model); porting them needs the legacy settings importer, which does not exist yet. Open decision: the legacy `MISTRAL_AMBIGUOUS_401_SOFT_LOCKOUT` flag defaults off (a bare Mistral 401 parks the connection as expired), while the native gateway deliberately softens it by default (three strikes per hour, documented in RUST_BACKEND_MIGRATION.md); the legacy predicate is also broader (any Mistral 401 without an explicit auth signal). Close legacy strategy/config import, disconnect/retry/reconciliation and remaining two-process SQLite races. |
| 8 | Full navigation, onboarding and settings | Medium-high | **Partial** | Provider detail deep links scope the connection list and default provider selection, and connection search respects that scope (UI CI 43556855203). Rustify found 106 legacy navigation surfaces, with 69 missing routes and 35 partial routes at the audit baseline. Restore only real, backed features and verify deep links/mobile/keyboard behavior. |
| 9 | Analytics, pricing, logs, timeline and route diagnosis | Medium-high | **Partial** | Pricing and aggregate usage are present. Add bounded detailed records, filters/drill-down/correlation, retention and decision/fallback traces. |
| 10 | Webhooks, exports and reports | Medium-high | **Partial** | Usage/audit sinks are narrower than the legacy surface. Add signed event webhooks, durable outbox/retry/replay and destination-specific reports including BigQuery dimensions. |
| 11 | Images, audio, video, search, files and batches | High | **Open** | Port exact HTTP/binary/stream/job contracts, provider transports, ownership, persistence, cancellation and accounting. |
| 12 | Full playground, discovery and protocol-translation UI | Medium | **Partial** | Text streaming and basic discovery exist. Add controls/history/compare/attachments/tool output plus explicit translator workflows backed by Rust contracts. |
| 13 | Cache, compression and token-savings metrics | High-very high | **Open** | Port cache isolation/TTL/invalidation and each opt-in compression engine with measured semantic and token-savings evidence. |
| 14 | MCP, A2A, memory, skills and guardrails | High-very high | **Open** | Implement durable tenant-scoped protocols/data/policies, cancellation, audit and bounded resource use; no placeholder pages count. |
| 15 | Agents, bridges, Conductor, orchestration and plugins | Very high | **Open** | Port lifecycle, durable jobs/workflows, restart recovery, permissions, secret handling and constrained extension boundaries. |

Validated in Rust CI run 43460310769: model quota admission combines matching
public and actual model names across reservations and settled usage. Preflight v2 counts legacy
custom-model, global/provider alias, managed-alias and compatibility namespaces
without disclosing contents; these are row counts, not imported models. Neither
change by itself completes the legacy model/alias migration.

The baseline `src/app/api/v1/models/catalog.ts` also combines static registry
entries, synchronized per-connection models, custom models, aliases, modality
registries and activation/connection rules. Its `catalogResponse.ts` adds
variants, post-filters, pagination and client formatting. Direct discovery now
combines configured chat models with matching models.dev entries for eligible
accounts and includes eligible synchronized per-connection inventory. It does
not yet honor the key's flat model-ID format. Of those post-filters, the Rust
`/v1/models` now applies the exact-duplicate guard, decision roles
(`systemone`), the `?capabilities=` filter and OpenAI `limit`/`after` paging in
the legacy order, ported with Rustify (Rust CI 44383753407). It also groups
rows by owner in the legacy provider precedence (combos first, then the
registry order snapshotted from the baseline, then unknown owners) and adds the
empty `models` array the Codex CLI decoder needs. Combo rows carry `strategy`
(with the v0.33.0 name `fallback` for priority), `routing_strategy` and
`members` for RedCode; members list only targets with a public provider that
the key may use. `/v1/models/{id}`, `/v1/models/systemone` (and `decisions`),
`/v1/models/info` and the discovery endpoints now read the same processed
listing, so decision models appear in the kind listing, `id_format` is `bare`
or `prefixed` as in `modelById.ts`, case-insensitive lookup follows JavaScript
lowercasing, and every view reports the same catalog version. Rust CI
44404356698 passed for these changes. They are not yet recorded in the Rustify
index: `catalogOrder.ts`, `catalogComboRouting.ts` and `modelById.ts` import
provider, routing-strategy and HTTP helper modules that are unported.
`/v1/models/web` and the legacy unconditional `HEAD` probe are not ported.
Decision rows now carry `availability: "not_probed"` and
`supported_endpoints: ["systemone", "decisions"]` as in the legacy listing (Rust
CI 44413597902). Direct model rows now list the metadata `name`, normalized for
display (vendor prefix removed, id-like names humanized), as the legacy default
`MODEL_CATALOG_INCLUDE_NAMES` does (Rust CI 44421233164). Turning names off,
`disambiguateCatalogModelNames` and names for combo and alias rows are not
ported. Provider metadata is descriptive and must not itself grant
access to inference or guarantee upstream entitlement. SQLite instances now
schedule refreshes after a 30-second startup delay, with a shared daily lease,
five-minute failure backoff and the existing last-good snapshot.
The authenticated manual refresh remains available. Shared scheduling for the
other database backends remains open.

Successful connection discovery now stores sanitized SQLite snapshots bound
to connection, tenant, credential/configuration and probe generation. The
client catalog consumes a shared in-memory snapshot scoped to the accounts
allowed by the client key. An earlier Rust CI run exposed slow propagation to a
second instance; inventory-only updates now rebuild the account inventory without
recreating provider clients or decrypting credentials again (Rust CI 43520919898).
Direct requests, aliases and combo targets for legacy self-hosted provider IDs now use each account's
nonempty, fresh, verified inventory to skip hosts that do not advertise the
model. Missing, empty, expired and imported-with-unknown-age inventories fail
open; hosted providers retain their prior selection. Imported inventories get
durable provenance, and only a successful new probe clears it. Existing
first-generation staged inventories are conservatively marked unknown once on
upgrade. Validation is pending; the full legacy authoritative-catalog rules and
tenant-scoped selection still need separate coverage and implementation.
The offline cutover now preserves legacy `syncedAvailableModels`, `customModels`
and `modelCompatOverrides` records in separate staging tables, including hidden
decisions and fields not yet supported by Rust.
The SQLite cutover now imports chat activation defaults per provider and owning
organization, plus explicit custom-model and compatibility decisions. Entries
that only control visibility do not create models. For migrated providers, the
Rust proxy also rejects inactive inference targets, including combo targets; native
visibility controls remain list-only. Rust CI 43523079672 passed. Import refuses
to silently change activation defaults on an already configured
native provider. Other modalities and unsupported compatibility fields still
require migration.
An operator can restore a staged per-account inventory for a matching migrated
API-key connection. The restore checks the tenant, account, credential, provider
and configuration, requires imported activation defaults and refuses to replace
a discovery that has started. Only metadata with a supported native equivalent
is accepted; the original remains staged. The UI keeps showing that restored
models are unverified after reload until a live discovery succeeds. OAuth,
unsupported metadata and broader
failure/restart validation remain open. Rust, Windows storage, FastLLM concurrent
agent benchmarks, UI tests and product checks passed for code commit cd2dcb66e
(CI runs 43525639243, 43525639555 and 43525639350). These tests cover SQLite
adoption and HTTP access denial, not a full browser-to-Rust migration rehearsal.

## Current execution order

1. Finish item 1 by validating imported compatible-account bindings, then port
   the remaining presets/media variants and prove the complete cutover path.
2. Port legacy custom models and alias rows. A first offline importer handles
   manually created chat model metadata, input/output limits and thinking flags
   for ordinary provider IDs; it rejects unsupported fields and conflicts
   transactionally. Full Rust CI passed in run 43468887364; product checks
   passed in 43468893389. Exact custom node IDs now resolve through matching
   imported definitions and preserve tenant ownership; matching provider and
   legacy OpenCode sibling compatibility overrides block a lossy import. Rust
   CI run 43477782245 and product checks 43475643050 passed. The offline
   cutover now invokes this importer after node definitions and restores the
   destination if it encounters unsupported model settings. The cutover now
   closes SQLite connections before verification or rollback on Windows (Rust
   CI run 43483203079 and product checks 43483203248 passed). The alias
   importer handles exact aliases for recognized built-in OpenAI-compatible
   chat transports including OpenRouter and their pinned legacy provider
   prefixes (for example `ds`), applying Settings precedence. The
   full cutover runs the importer and restores the prior database on unsupported
   alias behavior. Rust CI 43495427853 passed. Prefix stripping, multi-tenant mapping and unsupported
   target protocols still need migration; these cases are rejected explicitly.
   Other model formats and compatibility settings remain open.
3. Implement item 3 selection and admission fields because items 4 and 7 depend
   on their account ordering and queue semantics.
4. Continue down the table in vertical slices: runtime behavior, persistence,
   legacy import, SPA, tests, CI. Update this ledger in the same commit as each
   state transition.
