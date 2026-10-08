---
title: "ADR: Pluggable persistence boundary"
status: accepted
lastUpdated: 2026-10-08
---

# ADR: Pluggable persistence boundary

- **Status:** Architecture accepted on 2026-10-08; external implementations pending
- **Tracking issue:** [#8075](https://github.com/reddb-io/red-router/issues/8075)
- **Scope:** Local/offline SQLite and connected/server RedDB or PostgreSQL; this document records
  the selected architecture and delivery requirements, without adding backend support

## Context

RedRouter currently presents domain-oriented persistence functions from `src/lib/db/`, while the
shared connection returned by `src/lib/db/core.ts` implements the synchronous `SqliteAdapter`
contract in `src/lib/db/adapters/types.ts`. That adapter supports several SQLite runtimes, but its
surface remains SQLite-shaped: synchronous prepared statements, `pragma`, deferred and immediate
transactions, native/file-copy backup, checkpoint, and a local database handle.

The current startup and recovery path also owns the SQLite file lifecycle. `src/lib/db/core.ts`
resolves `storage.sqlite`, maintains one process-global adapter, checkpoints WAL, preserves selected
tables during recovery, and removes SQLite companion files when rebuilding a database. Driver
selection in `src/lib/db/adapters/driverFactory.ts` chooses among the supported SQLite runtimes; it
is not an external-backend abstraction.

Schema evolution is similarly coupled. `src/lib/db/migrationRunner.ts` applies numbered SQL files,
probes `sqlite_master` and `PRAGMA table_info`, detects optional FTS5 support, and runs migration
work in SQLite transactions. Operational modules such as `src/lib/db/backup.ts` and
`src/lib/db/optimizationSettings.ts` use backup, `PRAGMA`, WAL, page-size, auto-vacuum, and `VACUUM`
semantics directly.

These are valid properties of the embedded SQLite deployment. They should remain available without
forcing RedDB or PostgreSQL to emulate a SQLite API.

## Decision

Provide two deployment choices:

| Deployment       | Durable authority   | Configuration                                       |
| ---------------- | ------------------- | --------------------------------------------------- |
| Local/offline    | SQLite              | Default; no external database service required      |
| Connected/server | RedDB or PostgreSQL | Explicitly selected and configured per installation |

"Offline" describes independence from an external persistence service, not offline availability
of upstream AI providers. "Online" describes a connected database deployment. These are deployment
choices, not connection-status detection. A connected installation may reach a database on the
same machine, a private network, or a remote host.

Each installation has one configured durable authority. Database loss must produce bounded,
classified failures and accurate readiness rather than silently writing to a local SQLite file.
Cached reads, where allowed, must have explicit staleness and authorization rules. Automatic
offline writes, dual writes, and later synchronization require a separate conflict-resolution
and reconciliation design; they are outside this decision.

The current runtime remains SQLite-only. The existing RedDB usage-sink transport in
`src/lib/usageSinks/transports/reddb.ts` delivers events to a queue; it does not implement the
durable authority described here. Backend names in this ADR are design choices, not available
environment variables or CLI options.

Adopt a two-level persistence boundary for portable durable state:

1. **Domain repository contracts** define the persistence operations needed by business and routing
   code. Callers depend on domain behavior and domain data, not SQL text, prepared statements,
   database files, or dialect objects.
2. **An internal asynchronous backend contract** supports repository implementations with
   transaction contexts, health/readiness, migration coordination, backend capabilities, and
   classified errors. The exact TypeScript surface will be proposed with the first implementation
   PR and proven by conformance tests; this ADR intentionally does not freeze a speculative API.

SQLite remains the default implementation. The existing SQLite driver cascade and synchronous
`SqliteAdapter` stay behind the SQLite repository implementation while domains are migrated in
small vertical slices. No user is required to configure an external service.

RedDB and PostgreSQL are peer external implementations of the same repository contracts and
behavioral conformance suite. Prove the first bounded slice against SQLite, then implement it
for RedDB and PostgreSQL. No backend may fork routing or business policy. RedDB protocol or SQL
compatibility must be verified per operation; PostgreSQL compatibility alone is not evidence
that a PostgreSQL repository also works on RedDB. MySQL is outside the selected delivery scope.

## Boundary rules

### Portable repository surface

A portable repository may expose:

- domain reads and writes;
- explicit atomic operations and transaction-scoped repository access;
- compare/update or lease operations where concurrency semantics are part of the domain;
- backend-neutral pagination, ordering, and constraint errors.

Backend health, readiness, and migration coordination belong to the internal backend/operational
contract rather than to individual domain repositories.

A portable repository must not expose:

- `prepare`, `get`, `all`, `run`, or raw driver handles;
- `PRAGMA`, WAL checkpoint modes, `VACUUM`, or page/cache tuning;
- SQLite file paths, companion files, or file-copy backup;
- `lastInsertRowid` as a cross-backend domain contract;
- FTS5 or `sqlite-vec` syntax;
- a generic dialect escape hatch used by normal business code.

### Backend capability surface

Backend-specific behavior remains explicit and discoverable. SQLite-only maintenance stays behind
its own implementation and operational interface, including:

- runtime driver selection;
- WAL checkpoint and SQLite shutdown behavior;
- page-size, cache-size, and auto-vacuum settings;
- database-file backup, restore, and recovery;
- SQLite schema introspection;
- FTS5 and `sqlite-vec` integration.

An external backend is not required to imitate those features. Repositories must either use a
portable capability, provide a backend-specific implementation with documented behavior, or report
that a capability is unavailable.

## Transaction and migration model

Repository APIs define the atomic business operation; callers do not select a SQL transaction mode.
Each operation must define its observable concurrency guarantees: protected invariants, conflict
detection, retry classification, idempotency expectations, and transaction-context propagation.
Implementations may use different transaction and isolation mechanisms only when those observable
guarantees remain equivalent. SQLite may continue using its current deferred or immediate
transaction behavior internally where it satisfies the operation's contract.

External backends require explicit migration ownership so multiple application replicas cannot race
the same schema change. Backend migration histories may share logical milestones, but SQLite SQL
files are not assumed to be portable or reusable as another dialect.

## Cross-backend conformance semantics

Conformance tests must cover behavior, not only repository method signatures. Each migrated domain
must define and verify:

- timestamp timezone, precision, and serialization;
- `NULL` ordering, collation, and case-sensitivity expectations;
- JSON representation and comparison behavior;
- integer, decimal, and monetary precision;
- stable ordering and deterministic tie-breakers for pagination;
- ID generation without relying on SQLite row IDs;
- uniqueness and foreign-key violation classification;
- affected-row behavior for no-op, compare/update, and delete operations;
- concurrent-write outcomes, retryable conflicts, and idempotent retries.

If a domain cannot state equivalent observable semantics, it is not yet portable and must remain
backend-specific until that contract is designed.

## Compatibility requirements

Any implementation following this ADR must preserve these properties:

- SQLite remains the zero-configuration default.
- Existing SQLite files and migration history remain readable.
- npm, Electron, Docker, and restricted-runtime SQLite fallbacks retain their current startup path.
- Stored provider credentials continue to use the existing application encryption behavior.
- A repository migration does not silently change routing, quota, API-key, or audit semantics.
- Backup and recovery behavior is documented per backend rather than presented as universal.
- A clean SQLite-only installation does not load or require an external database driver.
- External selection is opt-in and remains stable across database outages and process restarts.
- RedDB and PostgreSQL preserve the same domain invariants, with explicit backend-specific
  migrations, backup/recovery and capability handling.

## Delivery sequence

1. Refresh the existing [SQLite coupling inventory](SQLITE_COUPLING_INVENTORY.md) against the
   implementation revision and identify durable versus node-local state.
2. Prove the existing combo and model-mapping repository contracts against SQLite, including
   transaction boundaries and the remaining synchronous compatibility call.
3. Introduce explicit backend selection and asynchronous backend operations behind those
   repositories, preserving SQLite startup and defaults.
4. Implement the same bounded slice for RedDB and PostgreSQL, with CI conformance for each
   backend, connection failures, migration ownership and concurrent writes. A partial slice
   must be labelled experimental and must not be advertised as full backend support.
5. Extend provider connections, API keys, settings and routing policy before shared-control-plane
   claims; preserve credential encryption, authorization and cache invalidation.
6. Extend usage/cost accounting, quotas and budgets with atomic reservations, idempotency,
   retry/recovery and coordinated jobs before multi-replica claims.
7. Deliver a validated, maintenance-mode SQLite-to-external migration and rollback path, plus
   backend-specific backup and recovery, before advertising database switching.

Each runtime step is a separate, reviewable PR. A later step must not be used to justify merging an
unproven abstraction in an earlier step.

## First implementation slice

Start with combos and model-combo mappings, whose domain contracts already exist in
`src/domain/persistence/comboRepositories.ts` and whose SQLite implementations are composed in
`src/lib/db/repositories/routingConfigRepositories.ts`. The synchronous `legacySync.getCombosCount`
path must be addressed explicitly. Inventory their consumers before changing backend selection.
The slice must include:

- SQLite behavior-preservation tests;
- repository conformance tests;
- explicit transaction boundaries;
- independent RedDB and PostgreSQL conformance, migration-ownership and outage checks;
- encryption and redaction verification for stored credentials;
- no change to the default startup configuration.

## Alternatives considered

### Add PostgreSQL beneath `SqliteAdapter`

Rejected. `SqliteAdapter` is a compatibility layer for SQLite runtimes and exposes SQLite-specific
operations. Emulating that surface would leak synchronous and dialect-specific assumptions into a
new backend.

### Expose a generic query/execute API to all domains

Rejected as the primary boundary. It would centralize connection handling but leave SQL dialect,
transaction, and table coupling in business modules. A low-level backend primitive may exist inside
repository implementations, not as the application-facing persistence API.

### Rewrite all persistence before validating one slice

Rejected. The current persistence surface is broad and includes file lifecycle, recovery, search,
and operational settings. Vertical slices provide reviewable behavior and rollback boundaries.

### Replace SQLite as the default

Rejected. Embedded and desktop deployments depend on the current zero-service startup model. An
external backend is opt-in.

### Use Redis as the durable authority

Rejected. Redis may support explicitly ephemeral coordination, cache, or counters, but it does not
replace the durable repository contract described here.

## Consequences

### Positive

- Business code gains a stable persistence seam independent of database dialect.
- SQLite behavior is tested before an external backend defines the abstraction.
- RedDB and PostgreSQL share contracts and tests instead of duplicating domain logic.
- SQLite-only capabilities remain first-class rather than becoming leaky compatibility shims.
- Multi-replica migration and transaction behavior becomes an explicit design concern.

### Costs and risks

- Repository extraction requires incremental call-site migration.
- Async boundaries may propagate through currently synchronous service code.
- Cross-backend semantics require conformance tests beyond SQL syntax compatibility.
- Backup, search, vector storage, and maintenance remain capability-specific.
- Running more than one persistence implementation increases CI and operational support cost.

## Non-goals

This ADR does not:

- add a database dependency, environment variable, schema, or migration;
- change the live SQLite singleton or driver cascade;
- promise RedDB or PostgreSQL support in a specific release;
- make FTS5, `sqlite-vec`, backup files, or SQLite maintenance portable;
- define active-active readiness before shared-state and coordination tests exist;
- approve a one-shot rewrite of `src/lib/db/`;
- provide automatic database failover to SQLite or offline/online data synchronization.

## Implementation questions

1. Which RedDB client/transport preserves the first slice's transaction and parameter semantics?
2. Which connection configuration, timeout and readiness contracts serve both external backends?
3. Which state remains node-local, and what cache invalidation or lease ownership does each shared
   domain require?
4. What compatibility window is required for interrupted or rolled-back data migration?

Resolve these details in the relevant implementation slice using source and behavioral evidence.
The architecture decision does not change the current SQLite runtime or establish replica safety.
