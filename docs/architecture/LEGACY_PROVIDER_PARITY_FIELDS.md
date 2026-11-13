# Provider configuration: concrete gaps in the port

Baseline: `525a71de4ac25968d0a25e52eeb1b09cc21c6e92` (last first-parent
`origin/main` commit before 2026-10-29). Read together with the 71-front
[full backlog](LEGACY_RUST_PARITY_BACKLOG.md) and the generated inventory of
106 navigation surfaces / 803 API files. This is a field-level expansion of
CORE-03/04/09 and API-04, not a replacement or a completion percentage.

Evidence: `src/shared/validation/schemas/provider.ts`, `src/app/api/providers/`,
`src/app/api/provider-nodes/`, `src/lib/db/providers.ts`,
`open-sse/executors/default.ts`. Native contracts: `control_plane.rs` ProviderInput,
ProviderView and provider routes; `legacy_providers.rs`; SPA provider page.

**Partial** means something concrete exists but legacy equivalence is unproven.
**Missing contract** means ProviderInput/SPA lacks that operation; helpers in other
modules do not establish a port. **Review** requires tracing the actual consumer.
Every row needs SQLite persistence, request behavior, import and regression evidence.

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
| PV-17 | P0 / L | Node `name/prefix/type/apiType/baseUrl` | Native tenant-scoped definitions now persist name/prefix/protocol/base URL and account bindings, with SPA CRUD, inherited runtime transport, namespace guards and explicit approval for shared endpoint changes. Strict offline import now maps supported legacy definitions, encrypted headers and disabled compatible-account bindings transactionally, pending CI. Presets, remaining types and distributed lifecycle races still require acceptance. |
| PV-18 | P0 / M | Node `chatPath/modelsPath` | Recognized inference endpoint URLs plus persisted per-connection model-discovery paths and SPA querying now exist. Discovery preserves same-origin credentials, pagination and bounded responses. Explicit native API protocol selection now allows arbitrary inference paths and persists across restart, diagnostics and combos; protocol persistence passed CI at `6ccb581b4`. Legacy definition/account import now preserves custom chat/model paths and query strings, pending CI; full cutover acceptance remains open. |
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

Execution: validate PV-17/18 compatible-account import and finish PV-25/26 (usable compatible provider/model
management) → PV-02/03/04/05 and PV-06/07/08/09 (selection/admission) → remaining
P0 rows, then P1. OAuth and legacy cutover remain separate acceptance requirements.

Header boundary: GET returns names/revision only; PUT replaces the entire map;
empty map removes it. Metadata/credential edits retain the map. Changing provider,
tenant or endpoint detaches it, preventing disclosure to a different destination.
Headers are compiled into runtime snapshots rather than read from SQLite per request.
OAuth/CLI connections retain their transport-owned identity headers; this slice does
not enable custom headers there. Invalid persisted values fail closed. It does not
lift existing legacy importer rejection for provider-specific settings.
