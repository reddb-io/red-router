---
title: "Experimental external routing storage"
status: experimental
lastUpdated: 2026-10-08
---

# Experimental external routing storage

The first external persistence slice covers combos and model-combo mappings. SQLite is
the default. Explicit selection of RedDB or PostgreSQL moves only those two repositories
to a PostgreSQL-wire database. Provider credentials, API keys, settings, usage, quotas,
tenant ownership and the rest of the durable state remain node-local SQLite.

This is a single-node experiment, not a complete external backend, database switching
feature, offline synchronization service or multi-replica deployment. Existing SQLite
data is not uploaded automatically. Independent engine validation is defined in the
`Routing storage` jobs in [the product workflow](../../.github/workflows/red-publish.yml);
a checked-in adapter alone does not establish support on an engine or packaged runtime.

## Selection and startup

The implementation in
[routingStorageConfig.ts](../../src/lib/db/repositories/routingStorageConfig.ts) reads:

| Variable                          | Values                                                  |
| --------------------------------- | ------------------------------------------------------- |
| `RED_ROUTER_ROUTING_BACKEND`      | `sqlite` (default), `reddb`, `postgres`                 |
| `RED_ROUTER_ROUTING_DATABASE_URL` | PostgreSQL-wire URL required for either external choice |

Selection is frozen on first repository access for the process lifetime. Restart after
changing installation configuration. Keep the URL server-side; it can contain credentials.
The optional `pg` driver is loaded only when an external operation needs it. Installations
that omit optional dependencies must install that driver before selecting an external backend.

Initialization is an explicit, exclusive maintenance operation. Stop every application
writer first. Runtime requests never create the schema or seed missing state. The initializer
uses a unique singleton row and never overwrites existing routing data. It does not provide
automatic distributed migration locking; two concurrent initializers may fail safely.

The commands below operate from a **source checkout with dependencies installed**. They are
not published CLI commands. Every command requires `--maintenance` as acknowledgement that
all application writers have been stopped. The script cannot prove operator exclusivity.

With the external variables configured:

```bash
node --import tsx/esm scripts/ops/routing-storage.ts initialize --maintenance
node --import tsx/esm scripts/ops/routing-storage.ts export routing-snapshot.json --maintenance
```

Use an authenticated RedDB PostgreSQL-wire listener or PostgreSQL endpoint. CI binds an
anonymous RedDB listener only on its isolated runner's loopback address; that is not a
production configuration.

## Bounded export and recovery

To copy the routing slice from SQLite while its writer is stopped, keep `DATA_DIR` pointing
at the existing installation and export it before changing the routing backend:

```bash
node --import tsx/esm scripts/ops/routing-storage.ts export-sqlite routing-snapshot.json --maintenance
```

After configuring and initializing an external destination, import that snapshot:

```bash
node --import tsx/esm scripts/ops/routing-storage.ts import-empty routing-snapshot.json --maintenance
```

Export creates a new file with mode 0600 and refuses to replace an existing file. Import
validates size, schema version, uniqueness and mapping references; it accepts only an
empty destination and uses a single compare-and-swap. Existing or concurrently changed
routing state is never overwritten. This procedure does not migrate provider credentials,
API keys, settings, accounting or tenant state.

External export can be restored into a separately initialized empty external destination.
Verify the destination before resuming the writer. Keep node-local SQLite backups separately.
SQLite file backups alone do not contain the external routing authority. Whole-database
export/import/restore and legacy JSON backup routes are refused with HTTP 409 when this
slice is selected, rather than presenting a partial backup as a complete restore path.
Manual and automatic SQLite snapshots still protect node-local data only.

Returning to SQLite simply selects the older local routing state; it does not copy later
external edits back. A validated external-to-SQLite rollback/import path remains pending.
Do not switch a live installation expecting automatic reconciliation.

## Atomicity, failures and local effects

[PgRoutingSnapshotStorage](../../src/lib/db/repositories/pgRoutingSnapshotStorage.ts) stores
one versioned aggregate in `redrouter_routing_state`. A revision compare-and-swap commits
combo/mapping changes, mapping cascades and reorder as one write. Names preserve exact
uniqueness and ASCII case-insensitive fallback lookup, matching SQLite's NOCASE behavior.

The aggregate is limited to **1 MiB** and every mutation reads and rewrites it. This is a
bounded conformance slice, not a scaling strategy for large configurations. Confirmed
revision conflicts retry at most eight times. Connection/query timeout is five seconds.
Transport failures are not retried automatically because the write may already have
committed. Re-read before repeating an operation after an ambiguous outcome.

Database loss does not change the selected backend and never sends routing writes to SQLite.
Storage failures use fixed public messages. The lightweight `/api/health/ping` readiness
check includes both node-local SQLite and the selected routing authority and returns 503
on failure. `/healthz` also checks the external authority once the server is ready
and supports GET/HEAD with a fixed 503 response during outages. `/api/health`
remains a process liveness endpoint.

Proxy assignments, rotation state, context history, LKGP pins and cache generations remain
local. Combo deletion commits cleanup metadata in the same external write as its mapping
cascade. Readiness and the next combo write replay local cleanup and acknowledge it only
after success. A failed local cleanup does not undo or misreport the committed durable
delete; pending metadata survives restart. Recreating that combo name/ID is refused until
cleanup completes. There is no transaction spanning both databases, and cleanup recovery
assumes one application node. Existing routing caches retain their local TTL/generation
behavior; the slice does not establish cross-process invalidation.

External routing refuses access whenever a non-default tenant exists, including tenants
created after startup. Tenant ownership/sharing queries, combo counters, SQLite health
repair, paid-model setting rewrites and JSON migration still target SQLite tables. Those
consumers need a further repository migration; this experiment must not be used for
multi-tenant installations or as evidence of parity for those features.

## Validation boundary

Product tests under `tests/redrouter/native/` cover SQLite and snapshot repository
conformance, compare-and-swap writers, uniqueness, cascades, failed cleanup recovery,
missing initialization, bounded conflicts, redacted outages, readiness and empty-only
maintenance import. The dedicated CI matrix runs the same domain harness against
PostgreSQL 17.6 and a checksum-verified RedDB v1.23.4 binary independently, followed
by persistence checks across a PostgreSQL restart and an abrupt RedDB process kill.

Build/package smoke remains a separate product gate. The CI database listener checks do
not prove Electron, restricted-runtime packaging, remote TLS deployment, distributed leases,
atomic budgets, provider encryption migration or replica failover. The architecture and
subsequent acceptance requirements remain in the
[persistence boundary ADR](persistence-backend-boundary.md).
