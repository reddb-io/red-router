---
title: "Rust backend migration"
status: accepted
lastUpdated: 2026-11-07
---

# Rust backend migration

## Target topology

RedRouter's production target has one authoritative backend process:

```text
clients ── inference protocols ──> red-routerd (Rust) ──> providers / optional FastLLM
                                      │
browser ── static SPA + admin API ────┤
                                      └──> SQLite (default), RedDB or PostgreSQL
```

Rust owns provider credentials, API keys, routing, policies, quotas, accounting,
configuration migrations and operational readiness. The browser receives only redacted
configuration. FastLLM is an optional private execution engine; all public traffic must
still cross the RedRouter authentication, policy and accounting boundary.

The TypeScript server remains a behavioral reference and compatibility runtime while
domains are moved. It is not part of the final serving topology, and new durable product
features must not be implemented only there.

## Migration rules

1. Move complete vertical slices: schema, repository, authenticated API, live runtime
   behavior, restart persistence and CI acceptance together.
2. Keep one durable authority. Database failure fails readiness and writes; it never
   falls back to a second local database.
3. Provider secrets are encrypted before storage, redacted from APIs and logs, and
   replaced atomically in the live runtime only after durable commit.
4. The SPA never opens SQLite or calls an internal FastLLM listener.
5. Preserve RedRouter's public protocols and dashboard concepts; upstream projects are
   implementation sources, not replacement products.
6. Do not route a migrated domain back through Next.js. Compatibility readers may remain
   temporarily, but the Rust API becomes authoritative once its migration is enabled.

## Delivery map

| Slice                       | Rust authority         | Acceptance                                                                         |
| --------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| Provider connections        | Implemented foundation | Authenticated CRUD, encrypted secrets, live reload, restart persistence, readiness |
| API/client keys             | Implemented foundation | Hash-only lookup, scopes, endpoint/model/connection grants, revocation, expiry     |
| Combos and routing          | Implemented foundation | Durable OpenAI priority/round-robin/weighted/random routes, grants and live reload  |
| Pricing, quotas and budgets | Partial                | Atomic reservations, streaming settlement, reconciliation, multi-process tests     |
| Usage and audit             | Partial                | Complete protocol usage, idempotent ledger, retention/export APIs                  |
| Settings and resilience     | Pending                | Versioned settings snapshots, health state and live invalidation                   |
| SPA delivery                | Pending                | Rust-served static assets, same-origin admin API, no Next.js runtime               |
| Legacy data migration       | Pending                | Maintenance-mode import, verification report and rollback boundary                 |

## Rust-owned production slices

The provider slice uses `redrouter_control_providers` in the configured Rust storage
backend. `red-routerd` validates and DNS-pins an endpoint before committing it, stores
only authenticated ciphertext for its credential, then reloads the active record from
the durable authority before swapping the runtime target. Concurrent admin writers
converge on the enabled record with the greatest revision; disabling it selects the next
most recent enabled record. If no provider remains, `/readyz` and inference fail closed
while `/healthz` and the authenticated admin API remain available for repair.

This slice deliberately does not claim complete backend parity. Its purpose is to
establish the production ownership boundary that subsequent domains extend.

The client-key slice stores only a SHA-256 lookup hash and redacted policy metadata in
`redrouter_control_client_keys`. Authenticated admin writes durably commit before a new
immutable policy snapshot becomes visible to inference requests. Creating the first
durable key atomically retires the environment-key compatibility path. Revocation,
expiry, protocol scopes, endpoint/model/provider grants, rolling request limits and
per-key concurrency are enforced by Rust and survive restart. Provider grants name
Rust-owned provider IDs and are checked independently for every combo target before
selection or fallback.

The combo slice stores bounded routing records in `redrouter_control_combos` and exposes
only authenticated Rust admin APIs. The first durable combo makes this table the routing
authority: unknown aliases and a table with no enabled routes fail closed rather than
falling through to an environment route or the active provider. Priority, round-robin,
weighted and random selection, target model rewriting, provider grants, pre-response fallback, live snapshot
replacement and restart persistence are implemented for OpenAI-compatible chat. The
remaining dashboard strategies, health/circuit state and non-chat combo protocols remain
explicit follow-up work rather than compatibility calls back into Next.js.
