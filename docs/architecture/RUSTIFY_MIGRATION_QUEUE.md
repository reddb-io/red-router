# Rustify migration queue

This is the operator-facing completion ledger for replacing the historical
Next.js backend with the Rust server and static SPA. It is ordered exactly by
the requested product priorities. A row is complete only when its behavior,
existing-data migration, SQLite persistence, SPA/API contract and repository CI
have all passed. File counts and Rustify candidates are discovery evidence, not
completion percentages.

Baseline: legacy `525a71de4ac25968d0a25e52eeb1b09cc21c6e92`; Rustify
`bbf9ac726e4fbf511a77a4c9e818cd8fb7f9bcb7`. The detailed dependency graph and
71-front audit remain in [RUSTIFY_PARITY_AUDIT.md](RUSTIFY_PARITY_AUDIT.md).

| Order | Requested capability | Complexity | State | Current acceptance gap |
| ---: | --- | --- | --- | --- |
| 1 | Reusable compatible providers, custom paths and model discovery | Medium-high | **In progress** | Native definitions, account bindings, encrypted headers and authenticated discovery exist. Strict legacy import passed the full Rust gate. The SPA VibeProxy preset now normalizes the OpenAI-compatible root and passed UI/browser CI. Client discovery lists operator models and matching models.dev chat metadata for eligible tenant accounts, respecting key restrictions; grouped discovery separates providers, aliases and combos (CI pending). Catalog membership does not prove account entitlement. Still implement synchronized per-connection inventory, remaining presets/media variants and prove full cutover. |
| 2 | Custom models, aliases, context limits, capabilities and parameters | Medium-high | **In progress** | Custom metadata and aliases exist. Alias-aware reservation, settlement and operator reconciliation retain both the public name and actual upstream model transactionally and passed the full Rust/product gates. Offline import handles a supported subset of custom models and exact aliases transactionally; verified OpenAI-compatible custom-node aliases are also imported (CI pending). Managed, wildcard and provider-scoped aliases and unsupported model overrides still block cutover. Add their equivalent behavior and import, parameter policies and complete routing/accounting proof. |
| 3 | Account priorities, groups, default model and provider queues/limits | High | **In progress** | Account priority and default model now persist with provider revisions, are editable in the SPA, import from compatible API-key and supported staged OAuth accounts, and apply to alias account pools. Rust CI 43495427853 and UI CI 43495427813 passed. Direct `provider/model` routing now selects tenant-scoped account pools with fill-first fallback, policy checks and native usage accounting; CI includes concurrent mock-upstream timing (pending). Complete discovery, provider strategies, default-model behavior for bare non-alias requests, groups and PV-06..09 admission without a global agent cap. |
| 4 | OAuth/CLI per executor | High | **Partial** | A small native OAuth set and strict staged adoption exist. Port and verify every supported legacy executor independently, including refresh/revoke and terminal account state. |
| 5 | Faithful migration of credentials, policies, configuration and counters | High | **Partial / cutover blocker** | Strict transactional importers exist but deliberately refuse unsupported populated fields. Close each refusal, rehearse backup/import/restart/rollback and preserve ciphertext, ownership and counters. |
| 6 | Organizations, permissions, OIDC and key provisioning | High | **Partial** | Tenant/OIDC/key primitives exist. Complete roles/memberships, external identity provisioning and two-tenant denial/expiry/revocation coverage. |
| 7 | Quotas, concurrent reservations, combos, fallback and resilience | High | **Partial** | Native accounting/reservations/combos/breakers exist. Alias-model admission, settlement and operator reconciliation passed without replacing actual-model attribution. Close legacy strategy/config import, disconnect/retry/reconciliation and remaining two-process SQLite races. |
| 8 | Full navigation, onboarding and settings | Medium-high | **Partial** | SPA shell exists; Rustify found 106 legacy navigation surfaces, with 69 missing routes and 35 partial routes. Restore only real, backed features and verify deep links/mobile/keyboard behavior. |
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
accounts, but does not yet synchronize per-connection inventory, migrate
activation rules, honor the key's flat model-ID format, or reproduce those
post-filters. Provider metadata is descriptive and must not itself grant
access to inference or guarantee upstream entitlement. SQLite instances now
schedule refreshes after a 15-minute startup delay, with a shared daily lease,
five-minute failure backoff and the existing last-good snapshot (CI pending).
The authenticated manual refresh remains available. Shared scheduling for the
other database backends remains open.

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
   alias behavior. Rust CI 43495427853 passed. Managed and provider-scoped
   aliases, wildcards, prefix stripping, multi-tenant mapping and unsupported
   target protocols still need migration; these cases are rejected explicitly.
   Other model formats and compatibility settings remain open.
3. Implement item 3 selection and admission fields because items 4 and 7 depend
   on their account ordering and queue semantics.
4. Continue down the table in vertical slices: runtime behavior, persistence,
   legacy import, SPA, tests, CI. Update this ledger in the same commit as each
   state transition.
