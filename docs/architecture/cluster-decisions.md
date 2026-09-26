---
title: "Cluster Decisions"
version: 3.8.40
lastUpdated: 2026-06-28
---

# Cluster Decisions — Optional Sidecar Profiles

**Status:** historical proposal; not an active-active deployment guide
**Date:** 2026-06-20 (runtime topology rechecked 2026-09-26)
**Refs:** [#3932](https://github.com/diegosouzapw/OmniRoute/issues/3932), PR #4381

> **Current topology:** The checked-in [`docker-compose.yml`](../../docker-compose.yml)
> defines application variants behind profiles, each mounting the same
> `./data` path when selected. Select only one application variant for the
> default SQLite topology. It does **not** launch three replicas or a
> Caddy load balancer by default. Qdrant and Bifrost are optional sidecars, not
> replacements for shared control-plane persistence. Do not set multiple
> replicas against one SQLite file. The supported SQLite topology and the
> separate-process scale-out option are documented in the
> [Docker guide](../guides/DOCKER_GUIDE.md#scale-out-n-independent-processes).

## TL;DR

This 2026-06 proposal introduced optional `memory` (Qdrant) and `bifrost`
sidecar profiles, which are present in the current Compose file. It did not
add a shared SQL backend, replica coordination, or an active-active
application topology. The current default does not include three application
replicas or Caddy; select one application profile and keep SQLite single-writer.

## Why this is conservative

The historical proposal considered these components; read its capacity claims
as design motivation, not as measured current deployment guarantees:

- **Redis** handles rate-limit/cache workloads, not durable control-plane state.
- **SQLite + sqlite-vec + FTS5** cover local memory + vector + text-search (see [`src/lib/memory/vectorStore.ts:108`](../../src/lib/memory/vectorStore.ts)).
- **Caddy** was part of the proposed topology, not the checked-in Compose stack.
- **Bifrost** is already integrated as the Tier-1 router in [`src/app/api/v1/relay/chat/completions/bifrost/route.ts`](../../src/app/api/v1/relay/chat/completions/bifrost/route.ts) (sidecar proxy with kill switch via `BIFROST_ENABLED` env var — set `=0` to bypass the sidecar and fall through to the TS path).

The two profiles are default-off sidecar options, not SQLite scale-out or migrations.

## The two profiles

### `memory` — Qdrant Vector Memory Sidecar

**When to flip on:**

- > 1M embeddings per deployment (sqlite-vec starts to slow at scale).
- Multi-replica deployment that needs shared vector state across `omniroute-1/2/3`.
- You already have an external Qdrant cluster (Qdrant Cloud, on-prem).

**What it adds:**

| Service  | Image                   | Ports       | Notes                                                 |
| -------- | ----------------------- | ----------- | ----------------------------------------------------- |
| `qdrant` | `qdrant/qdrant:v1.12.4` | `6333` HTTP | HNSW index; persistent volume `omniroute_qdrant_data` |

**Activation:** flip `qdrantEnabled = true` in the Settings UI **or** set `QDRANT_HOST=qdrant` env. See [`src/lib/memory/qdrant.ts:60`](../../src/lib/memory/qdrant.ts) for the precedence rules (settings table → env var → default).

**Env vars:** `QDRANT_HOST`, `QDRANT_PORT`, `QDRANT_API_KEY`, `QDRANT_COLLECTION`, `QDRANT_VECTOR_SIZE`, `QDRANT_HNSW_EF_CONSTRUCT` (see `.env.example` lines 1672-1683).

### `bifrost` — Bifrost Tier-1 Router Sidecar

**When to flip on:**

- You run ≥3 `omniroute` replicas and want provider rotation centralised in a single Go process.
- You want a single audit/logging surface for upstream-provider requests across all replicas.
- You want horizontal scaling of the Tier-1 routing layer independent of the OmniRoute replicas.

**What it adds:**

| Service   | Image                             | Ports  | Notes                                                                   |
| --------- | --------------------------------- | ------ | ----------------------------------------------------------------------- |
| `bifrost` | `ghcr.io/maximhq/bifrost:v1.6.11` | `8080` | Go-based Tier-1 router; persistent logs volume `omniroute_bifrost_logs` |

**Activation:** set `BIFROST_BASE_URL=http://bifrost:8080` in `.env.example`. The existing sidecar proxy route at [`src/app/api/v1/relay/chat/completions/bifrost/route.ts`](../../src/app/api/v1/relay/chat/completions/bifrost/route.ts) (added in PR #4381) will pick this up automatically.

**Env vars:** `BIFROST_BASE_URL`, `BIFROST_API_KEY`, `BIFROST_STREAMING_ENABLED`, `BIFROST_TIMEOUT_MS` (see `.env.example` lines 1685-1695).

## What this PR explicitly does NOT do

The original issue thread floated a larger cluster rewrite. After auditing the actual workload shape, the following are **rejected** for the reasons given:

| Component                            | Verdict  | Reason                                                                                                 |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------ |
| **Dragonfly**                        | **DROP** | `redis:7-alpine` is already fine for the rate-limit workload at production scale; no ceiling to break. |
| **NATS**                             | **DROP** | Each `omniroute` replica is a single Node.js process; no multi-process pub/sub workload exists.        |
| **PostgreSQL**                       | **DROP** | SQLite + sqlite-vec + FTS5 cover all 3 use cases; 97 migrations + Electron packaging block migration.  |
| **Neo4j**                            | **DROP** | Routing is a 5-table join; recursive CTE on SQLite is sufficient.                                      |
| **MinIO**                            | **DROP** | No multi-MB blob workload; images/audio are passthrough proxies.                                       |
| **pgvector / pg_ai / pg_textsearch** | **DROP** | Same SQLite-ceiling reason as PostgreSQL; pgvector ecosystem fragmented.                               |
| **HAProxy / Envoy**                  | **DROP** | Caddy already does LB + TLS; both were explicitly rejected as Tier-1 routers (see `AGENTS.md`).        |

If a future use case proves out one of these, this doc is the place to amend.

## 4-week rollout (if approved)

1. **Wk 1** — Land this PR + verification of opt-in profiles with a 3-replica compose stack.
2. **Wk 2** — Bifrost full activation for OpenAI/Claude/Gemini/Ollama (4 of 14+ providers) using the sidecar proxy route at [`src/app/api/v1/relay/chat/completions/bifrost/route.ts`](../../src/app/api/v1/relay/chat/completions/bifrost/route.ts) (gated by `BIFROST_ENABLED`, kill-switchable at runtime).
3. **Wk 3** — Qdrant memory profile enabled in a single test deployment; measure latency delta vs sqlite-vec.
4. **Wk 4** — Observability healthchecks (`docker compose ps` exit codes + `wget` smoke tests); 71-pillar refresh per ADR-041.

## Files changed in this PR

| File                                                 | Change                                                                                                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml`                                 | +30 lines: `memory` profile (Qdrant), `bifrost` profile (Bifrost), persistent volumes, healthchecks.                                                                                                        |
| `.env.example`                                       | +24 lines: `QDRANT_*` (6 vars), `BIFROST_*` (4 vars).                                                                                                                                                       |
| `docs/reference/ENVIRONMENT.md`                      | +6 rows in section 25 for the `QDRANT_*` env vars.                                                                                                                                                          |
| `src/lib/memory/qdrant.ts`                           | +33 lines: env-var fallback chain (settings → env → default) for `QDRANT_HOST`/`QDRANT_PORT`/`QDRANT_API_KEY`/`QDRANT_COLLECTION`/`QDRANT_VECTOR_SIZE`/`QDRANT_HNSW_EF_CONSTRUCT`/`QDRANT_EMBEDDING_MODEL`. |
| `src/lib/memory/__tests__/qdrant-wiring.test.ts`     | +88 lines: 9 new test cases pinning the env-var fallback precedence.                                                                                                                                        |
| `docs/architecture/cluster-decisions.md` (this file) | NEW — decision record for the opt-in profiles.                                                                                                                                                              |
| `AGENTS.md`                                          | +1 line: pointer to this doc in the reference documentation table.                                                                                                                                          |

**Net touched code:** 4 production files (`docker-compose.yml`, `qdrant.ts`, `.env.example`, `ENVIRONMENT.md`), 1 test file (`qdrant-wiring.test.ts`), 2 doc files (`cluster-decisions.md`, `AGENTS.md`).
