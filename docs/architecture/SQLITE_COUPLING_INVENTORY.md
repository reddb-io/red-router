---
title: "SQLite coupling inventory for shared persistence"
status: assessment
lastUpdated: 2026-09-26
---

# SQLite coupling inventory for shared persistence

This is the read-only inventory requested by the proposed
[persistence boundary ADR](persistence-backend-boundary.md), not approval to add a
database backend. It describes the current code and the new video-job worktree
changes. SQLite remains the zero-configuration, single-writer default; multiple
application replicas must not open the same `storage.sqlite` file. See
[SQLite runtime topology](../ops/SQLITE_RUNTIME.md#single-writer-topology-ha-unsupported).

## Reproduce the inventory

From the repository root, inspect the relevant call sites (these commands do
not initialize a database or run tests):

```bash
rg -n 'getDbInstance\(|SqliteAdapter|\.immediate\(|\.transaction\(' src/lib/db src/sse/services/auth.ts
rg -n 'sqlite_master|PRAGMA|wal_checkpoint|VACUUM|\.backup\(' src/lib/db
rg -n 'new Map|new Set|setInterval' src/sse/services/auth.ts src/lib/db/quotaPools.ts src/lib/db/apiKeys/modelPermissionCache.ts src/lib/db/sessionAccountAffinity.ts
rg -n 'video_jobs|reserveVideoJob|markVideoJob' src/lib/db src/app/api/v1
```

Search hits are coupling candidates, not proof that every caller must become a
shared repository. Review each domain's observable semantics before migrating it.

## Coupling and replica risks

| Surface                        | Current evidence                                                                                                                                                                 | Consequence / required contract                                                                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database lifecycle             | `src/lib/db/core.ts` owns the process-global adapter, SQLite file recovery, WAL settings and checkpoint. `src/lib/db/adapters/types.ts` exposes the synchronous `SqliteAdapter`. | Keep SQLite startup and maintenance behind its own implementation. A shared backend needs an asynchronous repository boundary, not an emulated SQLite handle.                                              |
| Schema ownership               | `src/lib/db/migrationRunner.ts` reads numbered SQLite SQL files, records `_omniroute_migrations`, probes FTS5, and applies migrations in transactions.                           | External migrations require one owner across replicas, dialect-specific files, compatibility windows and rollback checks.                                                                                  |
| Operational features           | `src/lib/db/backup.ts` uses native backup and `sqlite_master`; `src/lib/db/optimizationSettings.ts` uses SQLite tuning and `VACUUM`.                                             | Backup, restore and tuning are backend capabilities, not portable domain methods.                                                                                                                          |
| Routing configuration          | `src/lib/db/repositories/routingConfigRepositories.ts` binds combo and model-mapping repositories to SQLite and still exposes a synchronous compatibility method.                | Existing contracts are a useful seam, but this composition root is not backend selection or replica readiness. Check async call sites and transaction semantics before using it as a first portable slice. |
| Credentials and account choice | `src/sse/services/auth.ts` persists cooldown state, but `selectionMutexes` and `markMutexes` are process-local maps.                                                             | A shared connection row alone cannot serialize account selection or failure marking across replicas. Define atomic selection/update or leases, then test concurrent failures and credential redaction.     |
| Quota and permission state     | `src/lib/db/quotaPools.ts` uses database transactions plus a process-local maintenance map; `src/lib/db/apiKeys/modelPermissionCache.ts` caches permissions in memory.           | Preserve quota invariants under concurrent writes and define cache invalidation or bounded staleness across nodes.                                                                                         |
| Session affinity               | `src/lib/db/sessionAccountAffinity.ts` stores provider/connection pins in SQLite `key_value`, with a process-local cleanup timer.                                                | Shared affinity needs an explicit TTL and conditional eviction contract; each replica running cleanup must be safe. In-flight SSE sessions still remain node-local.                                        |
| Async video jobs (worktree)    | `src/lib/db/videoJobs.ts` reserves in an immediate SQLite transaction; `190_video_jobs.sql` enforces owner/idempotency uniqueness and stores the originating connection.         | Preserve reserve-before-billable-POST, conflict detection and ambiguous-outcome handling across replicas. Shared storage alone does not prove exactly-once upstream execution or account-bound polling.    |

`tests/unit/db-video-jobs.test.ts` now includes a second-file-connection
uniqueness check for the video-job reservation key, plus contract assertions
for nullable idempotency, owner hashing, compare-and-set terminal states, and
ambiguous provider-native IDs. They are written for CI and have not been run
locally. These check SQLite behavior, not a distributed
exactly-once guarantee or multi-replica deployment safety.
It also does not address the API layer's constant owner scope for no-key video
callers; database uniqueness cannot provide caller isolation without a stable,
authenticated owner identity.

## Proposed first review gate

Before any external backend implementation, choose **one** bounded domain and
document its methods, atomic invariants, error classification, idempotency and
required ordering. Run the same behavioral conformance suite against the
existing SQLite implementation, including competing writers where relevant.
Keep the current SQLite startup and file readable throughout. The ADR's
maintainer questions (backend direction, first domain and shared-state scope)
remain open; this inventory does not answer them by assumption.

For a later multi-replica milestone, require evidence for migration ownership,
credential encryption, connection cooldowns, quota updates, permission-cache
invalidation, session affinity, video-job failover, SSE drain behavior and a
validated SQLite-to-external migration/rollback. Until those pass, the deployment
claim remains single-writer SQLite, not HA.
