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
| 1 | Reusable compatible providers, custom paths and model discovery | Medium-high | **In progress** | Native definitions, account bindings, encrypted headers and authenticated discovery exist. Strict legacy import preserves definitions, custom paths (including query strings), headers and disabled compatible-account bindings transactionally; the full Rust gate passed. Still implement presets/media variants and prove full cutover. |
| 2 | Custom models, aliases, context limits, capabilities and parameters | Medium-high | **In progress** | Custom metadata and aliases exist. Alias-aware reservation, settlement and operator reconciliation retain both the public name and actual upstream model transactionally and passed the full Rust/product gates. Import legacy model/alias rows, add parameter policies and finish routing/accounting proof. |
| 3 | Account priorities, groups, default model and provider queues/limits | High | **Open** | Implement the PV-02..09 selection/admission contracts without adding an arbitrary global agent cap; migrate and concurrency-test them. |
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

## Current execution order

1. Finish item 1 by validating imported compatible-account bindings, then port
   the remaining presets/media variants and prove the complete cutover path.
2. Validate the item 2 public-alias quota/accounting fix, then import legacy
   custom model and alias rows.
3. Implement item 3 selection and admission fields because items 4 and 7 depend
   on their account ordering and queue semantics.
4. Continue down the table in vertical slices: runtime behavior, persistence,
   legacy import, SPA, tests, CI. Update this ledger in the same commit as each
   state transition.
