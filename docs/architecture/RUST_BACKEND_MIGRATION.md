---
title: "Rust backend migration"
status: accepted
lastUpdated: 2026-11-08
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
| Combos and routing          | Implemented foundation | Durable deterministic, metadata-ranked, deck-random and load-aware routes and reload |
| Pricing, quotas and budgets | Partial                | Atomic reservations, streaming settlement, reconciliation, multi-process tests     |
| Usage and audit             | Partial                | Complete protocol usage, idempotent ledger, retention/export APIs                  |
| Settings and resilience     | Partial                | Durable provider breakers, connection cooldowns, model lockouts, provider-specific quota scope, terminal account states and reset API; the remaining versioned settings remain |
| Management identity         | Implemented foundation | Signed bearer, discovery, browser PKCE, encrypted session, CSRF/fetch-metadata binding and logout |
| SPA delivery                | Partial                | Rust serves a validated static bundle with safe SPA fallback; production dashboard export/packaging remains |
| Legacy data migration       | Pending                | Maintenance-mode import, verification report and rollback boundary                 |

## Latest Next.js feature inventory (0.60.1–0.60.5)

The functional upstream baseline was rechecked against `origin/main` on 2026-11-07.
The latest functional release is 0.60.5 (2026-10-16); the only newer mainline change is
CI scheduling metadata. These are the product changes from the preceding 30 days and
their Rust migration state:

| Next.js change | Rust state | Remaining acceptance work |
| --- | --- | --- |
| Frozen model-price snapshots in usage export | Implemented for product-SQLite chat and streaming | Move the ledger behind the Rust-owned storage repository and cover every protocol |
| Preserve unpriced chat and streaming consumption | Implemented as explicit opt-in with `pricing_known = 0` | Rust-owned reporting APIs and usage sinks |
| Durable embedding usage | Implemented for product-SQLite OpenAI-compatible responses | Move reservation and ledger ownership into the Rust storage repository |
| Operator/key reporting attributes | Implemented for product-SQLite chat, streaming and embeddings | Move attributes and the ledger behind the Rust-owned storage repository |
| Signed OIDC claim policies | Implemented foundation: signed bearer, browser flow, generic discovery, SPA auth bridge and Rust asset serving | Package the production SPA artifact; add provider-specific diagnostics beyond standard discovery |
| Preserve stream deltas when terminal snapshots omit output | Direct OpenAI relay is not affected | Add parity fixtures for every translating stream path before declaring complete |
| Bound router/cache/log stream retention | Rust SSE frames and channels are bounded | Audit admin logs, translated streams and future SPA subscriptions under sustained load |

This table is a migration queue, not a parity claim. The signed-token and browser
session security boundaries are Rust-owned. The existing dashboard detects the Rust auth
bootstrap, copies the CSRF cookie into admin requests and uses Rust discovery/configuration.
`red-routerd` can serve a prepared static bundle directly with route isolation, secure
headers, immutable caching for versioned chunks and no-store HTML. Remaining work is the
production dashboard export/packaging pipeline and provider-specific diagnostics rather
than a Next.js backend dependency.

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

The management-identity slice stores issuer, audience, explicit JWKS URI, claim
conditions and subject/e-mail allowlists in the selected Rust database backend. An
enabled replacement is committed only after a bounded, DNS-pinned and redirect-free
JWKS fetch contains a usable asymmetric verification key. Admin requests accept the
bootstrap key or a JWT with an approved algorithm, `kid`, issuer, audience, expiry and
policy match. Key rotation is cached with a throttled refresh on an unknown `kid`, so
untrusted tokens cannot cause one outbound fetch per request. Restart persistence and
the policy repository are covered for SQLite, RedDB and PostgreSQL; end-to-end signed
JWT behavior is covered against SQLite. The confidential browser-client record is also
Rust-owned: its secret is encrypted, its public origin and authorization/token endpoints
are explicit, and its revision is coupled to the signed-token policy. Login uses
Authorization Code + PKCE S256 with encrypted ten-minute state/nonce/verifier state;
the callback performs bounded, DNS-pinned, redirect-free token exchange and verifies
signature, issuer, audience/authorized party, nonce, claims and subject before minting
a 12-hour encrypted session. Rust admin API calls made with that session require a
matching CSRF cookie/header plus exact configured Origin, or same-origin Fetch Metadata when a
browser omits Origin on a read. Policy changes
invalidate prior sessions, logout expires all Rust auth cookies, and restart/storage
coverage includes SQLite and the common RedDB/PostgreSQL repository contract. A public
non-secret auth bootstrap, bounded standard discovery endpoint and browser fetch bridge are
implemented. With `RED_ROUTER_SPA_DIR`, Rust validates `index.html` at startup and serves the
static build itself. Reserved API namespaces and missing asset paths never fall through to the
SPA shell; HTML and the service worker are not cached, while `/_next/static/` assets are
immutable. Building and packaging the complete production dashboard plus provider-specific
diagnostics remain; neither requires a Next.js persistence or session backend.

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
weighted, random, strict-random deck, fill-first, least-used, power-of-two-choices,
cost-optimized, context-optimized, reset-aware, reset-window, headroom,
quota-weighted and durable last-known-good selection, target model rewriting, provider
grants, pre-response fallback, live snapshot replacement and restart persistence
are implemented for OpenAI chat, Responses, embeddings, Cohere rerank, native Anthropic
and Gemini. Provider endpoints are validated and pinned for the protocol implied by their
URL; an enabled combo cannot bind targets from a different protocol.

The read-only dashboard SQLite bridge accepts fixed OpenAI-compatible chat endpoints for
OpenAI, OpenRouter, Groq, Cerebras, SambaNova, Mistral, DeepSeek, Together, Perplexity,
Fireworks, xAI, NVIDIA NIM, AI21, Moonshot/Kimi, SiliconFlow and Novita. These mappings do
not accept dashboard-controlled endpoint overrides: custom and regional base URLs remain
fail-closed until the Rust provider repository can validate and persist them as owned
configuration.

The load-aware strategies use provider-wide atomic counters that survive route snapshot
replacement. Streaming attempts keep their counter until the upstream body is drained,
including the background drain used to settle usage after a client disconnect.
Cost and context strategies rank a fixed stack deck without adding a second request-path
allocation; their validated price and context-window metadata lives in the durable combo record.
The Rust control plane now reads the committed `anomalyco/models.dev` snapshot lazily by
exact native provider/model ID. It validates the snapshot manifest and provenance before use,
parses only providers touched by configured combos, and freezes available input/output cost
and context-window metadata into the durable combo record. Operator-supplied values retain
precedence. The catalog does not create connections, grant model access, rewrite native IDs or
select an upstream endpoint; those remain RedRouter-owned security and transport decisions.
The authenticated `GET /api/admin/model-catalog` endpoint returns the lightweight upstream
provider index and manifest; `GET /api/admin/model-catalog/{provider}` materializes the complete
metadata for only that exact models.dev provider, including models, capabilities, modalities,
limits, prices, dates and status. This keeps the dashboard catalog on the Rust backend without
eagerly retaining all provider model maps in proxy memory.
The client-facing `GET /v1/models` and `GET /api/v1/models` endpoints expose only configured
routes that the authenticated key can actually use. Models.dev enriches those rows but never
grants access. The response includes RedRouter's stable 16-hex catalog-version header, computed
without the volatile `created` timestamp, so RedCode can invalidate its cache when the key's
visible routes or metadata change without refreshing on every catalog read.
The same authenticated projection now backs `/v1/catalog` and `/v1/capabilities` (plus their
`/api/v1` aliases). Alternate discovery key headers are normalized only for these read paths,
unsupported query semantics fail explicitly, and every document carries the same private
catalog version. Capabilities advertise only implemented Rust strategies; System One is returned
as unavailable rather than being falsely promised. Successful inference responses identify the
actual provider/model selected after fallback through `X-RedRouter-Served-Model`; errors never
carry that header.
OpenAI-compatible single-model discovery at `/v1/models/{id}` and the RedCode metadata projection
at `/v1/models/info?id=...` use that same authenticated, key-scoped inventory. They therefore
cannot reveal a configured route hidden by endpoint, model or provider grants. Model info exposes
the implemented endpoint plus models.dev-derived context, modality and capability metadata; the
`systemone` and `decisions` kind lists remain empty while the Rust evaluator is unavailable.
Persisted key identity discovery at `/v1/key` and `/api/v1/key` is also Rust-owned. It returns
only the successfully authenticated key's redacted ID, label, role and model-ID format, never
builds the catalog, and refuses environment fallback keys because they have no durable identity.
The dashboard SQLite compatibility reader retains its existing per-key `flat`/`prefixed` setting;
Rust-owned keys persist the same setting in a revision-coupled preference record. The preference
is committed before the key revision and a mismatched revision fails closed, so an interrupted
two-record update cannot publish a partially changed identity. Missing legacy preferences default
to `prefixed`. As in the current TypeScript contract, this setting is discoverable but does not yet
rewrite the scoped catalog (`key_id_format_applied` remains false), and combo IDs stay unchanged.
Refreshing and atomically publishing a newer catalog snapshot from Rust remains separate
migration work.
Quota observations live in `redrouter_provider_quotas` with an explicit TTL. Admin
updates commit before the shared lock-free provider snapshot changes; route selection
reads only atomics and never queries SQLite/RedDB/PostgreSQL. Expired observations become
neutral capacity (stable definition-order ties, or a balanced quota-weighted draw).
Automatic provider-specific quota polling remains separate work.
Last-known-good uses an atomic index in the request path and persists target identity only
when the learned target changes. Retryable failure clears a matching pin before fallback;
startup and live reload discard pins whose combo, strategy or target no longer exists.
The remaining dashboard strategies remain explicit follow-up work rather than
compatibility calls back into Next.js.

Provider-wide circuit state is owned by `redrouter_provider_breakers` in the same
selected database authority. Network failures and upstream `408`, `500`, `502`, `503`
and `504` responses move a provider through closed, degraded, open and half-open states;
ordinary key/account/model responses such as `401`, `403` and `429` do not poison the
whole provider. Open providers are skipped before dispatch, one concurrent half-open
probe is allowed after the durable cooldown, and success or failure is committed before
the updated runtime state is accepted. The authenticated health API exposes only
non-secret state and supports durable per-provider thresholds, reset windows and an
operator reset that preserves those settings. Configuration is committed before the
live circuit changes and survives restart.

Connection and model availability is independently owned by
`redrouter_provider_availability`, keyed by the Rust provider-connection ID. The proxy
inspects only `400`, `401`, `402`, `403`, `404` and `429` bodies, with a 64 KiB and
two-second bound; normal responses and SSE remain streaming. Provider evidence separates
model entitlement failures from banned, expired and credits-exhausted account states, so
an aggregator's model-specific `401` cannot park the whole credential. Unreadable or
oversized error bodies are not relayed partially. Generic `401`, `403` and `429` failures
retain their conservative connection cooldown behavior, while `404` and classified model
errors lock only the failing model, leaving sibling models eligible. Both scopes are checked before
usage reservation or dispatch, cause combo fallback, survive restart and are cleared by
a successful recovery, provider credential change or authenticated health reset. A
generation permit prevents concurrent failures from multiplying the backoff. A separate
`redrouter_provider_resilience` record gives each provider an explicit `auto`, `connection`
or `model` rate-limit scope. Settings are coupled to the provider revision, so an interrupted
two-record update cannot publish a half-new runtime configuration. The automatic Rust policy
recognizes the current catalog's
main independently limited provider families; an operator override is persisted, returned
to the dashboard, applied to immutable route snapshots and survives restart. Model-scoped
`429` state retains upstream retry hints without cooling sibling models. Terminal account
states are persisted and exposed to the authenticated health API without provider error
bodies or credentials. Mistral's byte-identical bare `401` for revoked credentials and
exhausted quota receives three durable soft cooldown strikes per hour; the fourth failure
converges to terminal expiry. Concurrent responses consume one generation, successful
recovery clears the strike state, old array-only availability snapshots remain readable,
and the authenticated health API exposes only the count and limit. SQLite is
the selected production backend for this slice, while the common repository contract is
also exercised for embedded/remote RedDB and PostgreSQL. Expanding automatic classification
to the complete dynamic provider catalog and the remaining resilience settings exposed as
versioned dashboard configuration remain migration work.
