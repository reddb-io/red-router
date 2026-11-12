---
title: "Rust backend migration"
status: accepted
lastUpdated: 2026-11-11
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

| Slice                       | Rust authority         | Acceptance                                                                                                                                                                                                                                                                                                              |
| --------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider connections        | Implemented foundation | Authenticated CRUD, encrypted secrets, tenant ownership, live reload, restart persistence, readiness                                                                                                                                                                                                                    |
| API/client keys             | Implemented foundation | Hash-only lookup, scopes, endpoint/model/connection grants, revocation, expiry                                                                                                                                                                                                                                          |
| Combos and routing          | Implemented foundation | Tenant-isolated deterministic, metadata-ranked, deck-random and load-aware routes and reload                                                                                                                                                                                                                            |
| Pricing, quotas and budgets | Rust-owned SQLite      | Per-key request/token/day/monthly-spend admission plus organization/selected-key shared spend budgets use one concurrent SQLite reservation boundary across chat/Responses JSON+SSE, embedding, rerank, Anthropic and Gemini; tag/end-user scopes and non-SQLite quota stores remain                                    |
| Usage and audit             | Rust-owned SQLite      | Chat and Responses JSON/SSE plus embedding/rerank/Anthropic/Gemini ledger, bounded expired-counter maintenance and cursor-paginated tenant reporting; detailed ledger archival and remaining modal unit types remain                                                                                                    |
| Settings and resilience     | Partial                | Durable provider breakers, connection cooldowns, model lockouts, provider-specific quota scope, model-aware quota snapshots, terminal account states and a Rust SPA operator surface; the remaining versioned settings remain                                                                                           |
| Management identity         | Implemented foundation | Signed bearer, tenant/role binding, tenant-admin resource CRUD, scoped service provisioning, local bootstrap and browser PKCE sessions, CSRF/origin binding and logout                                                                                                                                                  |
| SPA delivery                | Production default     | Rust serves a validated static bundle with provider, resilience, routing, key, identity, usage, audit and OIDC views; its product pages live under `rust-dashboard` and cannot import the Next.js App Router; the Rust-only Docker artifact is the default Compose service and legacy Next requires an explicit profile |
| Legacy data migration       | Partial                | Offline preflight, bounded importers and an orchestrated generic cutover with structured report and retained rollback copy exist; provider-specific adoption, verification and activation remain                                                                                                                        |

## Latest Next.js feature inventory (0.60.1–0.60.5)

The functional upstream baseline was rechecked against `origin/main` on 2026-11-07.
The latest functional release is 0.60.5 (2026-10-16); the only newer mainline change is
CI scheduling metadata. These are the product changes from the preceding 30 days and
their Rust migration state:

| Next.js change                                             | Rust state                                                                                                                      | Remaining acceptance work                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Frozen model-price snapshots in usage export               | Product bridge and native Rust ledger persist exact token vectors and rerank search-unit prices used at settlement              | Cover the remaining protocol-specific unit prices                                                |
| Preserve unpriced chat and streaming consumption           | Implemented as explicit opt-in with `pricing_known = 0`                                                                         | Complete the remaining protocol sinks and retention policy                                       |
| Durable embedding usage                                    | Implemented for both product-SQLite and native Rust SQLite OpenAI-compatible responses                                          | Add protocol-wide fixtures outside embeddings                                                    |
| Operator/key reporting attributes                          | Implemented for product-SQLite chat, streaming and embeddings                                                                   | Move attributes and the ledger behind the Rust-owned storage repository                          |
| Signed OIDC claim policies                                 | Implemented foundation: signed bearer, browser flow, generic discovery, SPA auth bridge and Rust asset serving                  | Package the production SPA artifact; add provider-specific diagnostics beyond standard discovery |
| Preserve stream deltas when terminal snapshots omit output | Direct OpenAI relay is not affected                                                                                             | Add parity fixtures for every translating stream path before declaring complete                  |
| Bound router/cache/log stream retention                    | Rust SSE frames and channels are bounded                                                                                        | Audit admin logs, translated streams and future SPA subscriptions under sustained load           |
| Dashboard-managed usage sinks                              | BigQuery and signed HTTPS webhook instant exports are Rust-owned, tenant/key scoped, encrypted, live-reloaded and SQLite-backed | Migrate window aggregation plus SQS, Kafka and RedDB transports                                  |

This table is a migration queue, not a parity claim. The signed-token and browser
session security boundaries are Rust-owned. The existing dashboard detects the Rust auth
bootstrap, copies the CSRF cookie into admin requests and uses Rust discovery/configuration.
Its API-key manager now selects the Rust authority at runtime and uses the Rust-owned
hash-only issue, policy replacement, revocation and usage-report contracts. The Next key
manager remains the compatibility view only when the public auth bootstrap does not identify
an active Rust control plane; the Rust view never calls the legacy `/api/keys` persistence.
The provider manager now follows the same boundary and calls only Rust-owned provider CRUD
when that control plane is active. Its form preserves the stable connection ID used by keys,
policies and combos, treats replacement credentials as write-only and exposes the Rust
connection/model rate-limit scope. It consumes the Rust-owned `anomalyco/models.dev` index,
shows the active validated snapshot and revision, offers its provider namespace and lazily
inspects provider model metadata without downloading upstream data in the browser. Codex and
Claude browser authorization-code flows are now Rust-owned. The authorize response preserves
the dashboard contract, while a sealed ten-minute state binds provider, redirect, PKCE verifier
hash, actor and tenant. The exchange can complete on another replica sharing the storage key,
uses fixed provider endpoints with bounded redirect-free HTTP, and persists through the same
encrypted import path as CLI sessions. Other provider browser flows remain compatibility features
to migrate as separate vertical slices; they are not silently backed by the Next database in Rust
mode.
Codex CLI `auth.json` and Claude CLI `.credentials.json` imports are now Rust-owned for both the
dashboard's single and bulk JSON contracts. Codex derives a tenant-scoped stable connection
identity from the workspace and user claims, so two members of one ChatGPT workspace do not
collide. Claude performs a bounded, redirect-free bootstrap against the fixed Anthropic endpoint,
uses the returned account UUID as its stable identity, accepts an operator-supplied e-mail when
bootstrap cannot identify the account, and otherwise requires explicit unsafe-import intent.
Both importers require explicit overwrite for an existing account. Access and refresh tokens use
the normal encrypted provider/OAuth repositories, responses are redacted and non-cacheable, and
imports are audit logged. Codex and Claude bulk ZIP extraction is also Rust-owned: it never writes
archive contents to disk, runs decompression outside the async executor, preserves per-entry JSON
parse errors and rejects traversal, special/encrypted entries and compressed or expanded size
abuse. Rust now also preserves a revision-coupled encrypted session sidecar for fields that are not
derivable from the access/refresh pair (notably Codex `id_token` and Claude scopes/tier metadata).
The authenticated tenant-scoped export routes refresh expiring credentials, reconstruct the exact
Codex/Claude CLI documents, return them with non-cacheable download headers and audit only redacted
metadata. The central server never writes into a remote host's home directory; applying an export
to local CLI files belongs to the explicit desktop/companion boundary.
Antigravity CLI (`agy`) token import is also Rust-owned for single JSON, bulk JSON and bounded
ZIP extraction. Rust accepts nested and flat CLI formats, resolves account e-mail and Cloud Code
project metadata through fixed redirect-free Google endpoints, encrypts the refresh token and
revision-coupled session metadata, and uses the same tenant-scoped overwrite and audit rules. The
native `/v1/antigravity` transport preserves the Cloud Code envelope and SSE response, pins the
runtime endpoint, applies the official CLI identity and project header, and participates in combo
selection and token accounting without Next.js. A project-scoped `403` is retried exactly once
without `x-goog-user-project`, matching the CLI behavior for valid consumer sessions that cannot
bill the bootstrapped project. Its `agy`/`antigravity` provider names resolve
model context, capability and price metadata from the validated `models.dev` Google namespace.
Google refresh is coordinated by the same
cross-replica lease and generation CAS; deployments must provide
`ANTIGRAVITY_OAUTH_CLIENT_ID` and `ANTIGRAVITY_OAUTH_CLIENT_SECRET` for refresh. OpenAI Chat
Completions clients can now use persisted Antigravity combo targets without a TypeScript bridge:
Rust translates bounded messages, tools, tool choice and generation settings into the Cloud Code
envelope, translates JSON and fragmented SSE responses back to OpenAI text, reasoning, tool calls,
finish reasons and usage, and settles quota usage before publishing the terminal stream frame.
Gemini thought signatures remain server-side, are persisted with provider-scoped tool-call keys and
expiry, survive restart, and are reattached on the next tool turn; they are never returned to the
client. Browser OAuth is Rust-owned with the same Google scopes and non-PKCE native-client flow as
the proven legacy implementation. Its sealed state remains bound to actor, tenant, redirect and a
short-lived verifier; loopback HTTP callbacks are accepted, while public HTTPS callbacks must match
`ANTIGRAVITY_OAUTH_REDIRECT_URI`. Token exchange, identity/project bootstrap and encrypted session
persistence can complete on another Rust replica. Rust also owns the `ANTIGRAVITY_CREDITS` policy:
the default strips client-supplied credit controls, `retry` performs one bounded replay only for a
classified plan-quota 429, and `always` is explicit operator opt-in. Circuit, availability, fallback
and quota accounting observe only the final physical attempt. The remaining provider import formats
are still compatibility work.
Rust now owns the first OAuth persistence vertical for imported Codex and Claude sessions:
access and refresh tokens use separately authenticated ciphertext, reads expose only provider
kind and a string-encoded generation, and SQLite rotates the pair and expiry in one
`BEGIN IMMEDIATE` transaction guarded by generation CAS. This prevents a stale persistence
writer from restoring a consumed refresh token. Proactive refresh, cross-replica leasing,
generation-CAS rotation and durable reauthentication state for Codex and Claude are Rust-owned.
Rust also owns a generic protocol-native
connection diagnostic for configured
API-key or access-token providers: it uses the encrypted credential and pinned runtime
transport, bounds time and response bytes, and returns only a stable redacted result.
Account-specific quota probes, the remaining provider authorization flows and the local
CLI-owned session lifecycle remain follow-up work.
`red-routerd` can serve a prepared static bundle directly with route isolation, secure
headers, immutable caching for versioned chunks and no-store HTML. The Rust-only image
packages that bundle and is the default Compose service. Providers, combos, client keys,
usage, identity, audit, catalog, resilience and OIDC are owned by the independent
`rust-dashboard` source tree. Legacy Next pages only re-export the three shared Rust views
needed by the compatibility runtime; the SPA itself is guarded from importing `src/app` or
Next server/navigation modules. Remaining work is
provider-specific diagnostics rather than a Next.js backend dependency.

## Rust-owned production slices

The provider slice uses `redrouter_control_providers` in the configured Rust storage
backend. `red-routerd` validates and DNS-pins an endpoint before committing it, stores
only authenticated ciphertext for its credential, then reloads the active record from
the durable authority before swapping the runtime target. Concurrent admin writers
converge on the enabled record with the greatest revision; disabling it selects the next
most recent enabled record. If no provider remains, `/readyz` and inference fail closed
while `/healthz` and the authenticated admin API remain available for repair.

Provider ownership is stored in a revision-coupled sidecar so existing records remain
compatible as tenant `red` while new providers can belong to any enabled Rust-owned
tenant. Combo ownership uses the same fail-closed contract. A combo cannot reference a
provider from another tenant, and an authenticated client key can neither discover nor
execute a route outside its own tenant. Provider/combo IDs remain globally unique; no
external RedDB database identifier is stored or inferred.

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
SPA shell; HTML and the service worker are not cached, while versioned assets are immutable.
The production Rust image packages this dashboard. Provider-specific diagnostics remain;
they do not require a Next.js persistence or session backend.

The client-key slice stores only a SHA-256 lookup hash and redacted policy metadata in
`redrouter_control_client_keys`. Authenticated admin writes durably commit before a new
immutable policy snapshot becomes visible to inference requests. Creating the first
durable key atomically retires the environment-key compatibility path. Revocation,
expiry, protocol scopes, endpoint/model/provider grants, rolling request limits and
per-key concurrency are enforced by Rust and survive restart. Provider grants name
Rust-owned provider IDs and are checked independently for every combo target before
selection or fallback. Authenticated `POST /api/admin/client-keys` generates a random
`rrk_` secret, persists only its hash, returns the raw value once in a non-cacheable
response and assigns a random stable key ID. Its durable `label` is descriptive metadata;
organization ownership is not inferred from the label. Rust now owns stable tenants and a
revision-coupled key-ownership sidecar containing only `tenant_id` and authenticated
`created_by`. The default tenant is `red`; legacy keys are adopted as `red/legacy`, while
new keys reject missing or disabled tenants. No RedDB database identifier is stored in Red
Router: RedDB Cloud owns any database-to-key association outside this service.
Independent Rust replicas refresh the client-key/tenant snapshot from the shared authority
on a bounded two-second cadence. A malformed or partially committed generation makes that
replica reject client authentication until a complete snapshot can be read; disabling a
tenant therefore retires its keys across the cluster without reviving environment keys.
On SQLite, durable request-per-minute and request-per-day policies are admitted through
atomic `BEGIN IMMEDIATE` weighted-window counters shared by every Rust process using the
same file. Keys without those limits remain on the no-database-read inference path. Other
storage engines retain process-local request counters until equivalent atomic drivers exist.
The same revision-coupling applies to the native quota sidecar. SQLite-backed keys can own
token-per-minute, token-per-day and monthly micro-USD limits plus explicit per-attempt
reservation bounds. Admission and settlement are Rust-owned and use durable immediate
transactions against `redrouter_usage_reservations`, `redrouter_usage_ledger` and
`redrouter_usage_counters`; normal and SSE responses share the same accounting path.
Uncertain attempts remain reserved. Other storage engines keep the portable quota
configuration record but fail closed if a key tries to activate it until an equivalent
atomic ledger implementation exists. The authenticated Rust management API exposes a
bounded, non-cacheable usage report with exact token/micro-USD totals, pending reservations
and recent ledger entries. Token and Cohere-compatible rerank events retain distinct
`usage_kind` values; rerank records carry provider-billed search units with zero fabricated
tokens. Stable composite cursors page the immutable descending ledger
without loading an unbounded export into memory while totals continue to cover the complete
selected window. Global admins can filter by tenant and key; `tenant-admin` callers are
unconditionally restricted to their bound tenant.
Expired rolling-window counters are operational scratch state rather than financial
history. Rust prunes them hourly in bounded SQLite transactions and exposes an authenticated
global-admin maintenance trigger for catching up larger backlogs. The immutable usage ledger
and uncertain reservations are deliberately excluded: the legacy retention contract preserves
financial records independently, and deleting them before archival/export would destroy audit
and BigQuery guarantees.
Each priced native ledger row stores the complete models.dev token-price vector or the
persisted dashboard/models.dev/LiteLLM per-search-unit rerank price and capture time used for
settlement. Reports and BigQuery/webhook exports preserve the usage kind and search-unit
count instead of reclassifying rerank work as tokens. Reports return the frozen JSON object
instead of joining against the current catalog. The SQLite migration serializes with `BEGIN IMMEDIATE`; pre-snapshot
priced rows receive an explicit legacy marker, while unpriced rows remain distinguishable
from free usage.

Verified OIDC identity is deliberately separate from authorization. Durable identity
bindings associate an `oidc:` subject with one enabled tenant and an `admin`, `tenant-admin`
or `issuer` role. Only a bound `admin` can use the global management API. The scoped
provisioning API accepts the bootstrap recovery identity or a matching bound role, requires
an explicit tenant and refuses ownership changes for an existing key. Its PUT contract uses
a caller-chosen stable key ID and caller-generated secret: RedDB Cloud can retry after a lost
response while Red Router continues to persist only a hash. The caller retains the external
database-to-key mapping; Red Router retains tenant, label and authenticated creator only.
`tenant-admin` can use the provider, combo and client-key CRUD surfaces plus provider health,
quota-observation and LKGP operations, but list results are filtered to its tenant and every
create/update/delete operation enforces the same ownership. Omitted `tenant_id` is filled from
the binding; an explicit cross-tenant value is rejected. The shared models.dev catalog is
readable for route configuration, while tenant and identity binding administration remain
global-only. The `issuer` role does not inherit dashboard CRUD.

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
The Rust control plane reads the committed `anomalyco/models.dev` snapshot lazily by exact native
provider/model ID and can replace it through authenticated
`POST /api/admin/model-catalog/refresh`. Refreshes use the fixed models.dev catalog URL, bounded
timeouts and a 16 MiB response limit, forward the active ETag, normalize only public descriptive
fields, validate every provider before publication and discard upstream endpoints, environment
names, headers and credentials. The complete transformed snapshot is one durable row in the
selected SQLite, embedded/remote RedDB or PostgreSQL authority. A successful write happens before
one `Arc` swap publishes it, so requests see either the old or new generation and restart restores
the same generation. HTTP 304 leaves the record untouched; network, schema, validation or storage
failure keeps the last good in-memory snapshot. An invalid persisted row is rejected at startup in
favor of the bundled catalog and is reported in the admin snapshot status. Each replica probes only
the small revision column every five seconds; it downloads and validates the full row only after a
generation change, rechecks the revision after validation to prevent stale publication, and then
performs the same local `Arc` swap. Invalid generations are remembered and are not reparsed on every
poll.

Available input/output cost and context-window metadata is frozen into the durable combo record
when a combo is saved. Operator-supplied values retain precedence. The catalog does not create
connections, grant model access, rewrite native IDs or select an upstream endpoint; those remain
RedRouter-owned security and transport decisions.
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
Quota observations live in `redrouter_provider_quotas` with an explicit TTL. Admin
updates commit before the shared lock-free provider snapshot changes; route selection
reads only atomics and never queries SQLite/RedDB/PostgreSQL. Expired observations become
neutral capacity (stable definition-order ties, or a balanced quota-weighted draw).
SQLite deployments automatically poll supported OAuth providers (Codex, Claude and
Antigravity) every minute. A durable lease coalesces refreshes across Rust processes,
and the resulting aggregate and model-scoped observations update SQLite before the
lock-free routing snapshot. Manual refresh remains available for operator diagnostics.
Last-known-good uses an atomic index in the request path and persists target identity only
when the learned target changes. Retryable failure clears a matching pin before fallback;
startup and live reload discard pins whose combo, strategy or target no longer exists.
Prompt-cache affinity (`cache-optimized`) is Rust-owned and uses rendezvous hashing over
an explicit `prompt_cache_key` (including metadata) or a reusable system/tool/assistant
prefix. This preserves account locality without a per-conversation database lookup.
The Rust-owned `auto` strategy ranks the already-authorized, healthy target snapshot by
quota capacity, catalog-enriched cost and context, and current in-flight load. Selection
is allocation-free after the fixed eight-target deck is built and performs no storage or
network reads in the request path. Operators can assign independent normalized weights to
those four signals. The configuration is stored with the combo payload, survives restart
and live reload, and legacy array-only combo payloads retain the balanced defaults.
The Rust-owned `context-relay` strategy preserves dashboard target order and stores the
last successful provider/model for each explicit client session in
`redrouter_context_relay_sessions`. Session identifiers are validated at the HTTP boundary
and reduced to a domain-separated SHA-256 record key before persistence. A later model
switch injects a bounded handoff marker using the native Chat Completions, Responses,
Anthropic or Gemini system channel while preserving the client conversation. This state is
shared by Rust processes using the same database and survives restart. The Rust combo
contract and SPA now also persist the legacy handoff threshold, optional summary model,
provider allowlist, summary-message bound and schema-locked/standard relay mode. Values are
normalized and validated before the route snapshot changes, while combos created before
this payload extension retain the legacy defaults. On a model switch, Rust can now generate
a bounded structured summary asynchronously through an authorized OpenAI Chat, Responses,
Anthropic, translated Anthropic, native Gemini or Antigravity CLI target. Gemini uses its
native JSON content and structured-response configuration. Antigravity uses the official
project-aware request envelope and bounded SSE decoder, including the consumer-account retry
without the project billing header after a project-scoped `403`. The summary is stored with a
five-hour TTL and reused through the protocol-native handoff channel; one process coalesces concurrent
generation for the same combo/session. SQLite and PostgreSQL additionally coordinate that
generation across Rust replicas with an expiring durable lease; an old owner cannot release
its successor's lease, and a crashed owner cannot strand future generation. The summary call
has a deadline shorter than the lease so a slow response cannot outlive its ownership.
Summary calls use the selected provider's live availability gate, durable circuit breaker and
in-flight counter, so background work cannot bypass an open or unavailable connection and is
visible to load-aware routing. On SQLite, completed summaries are settled in the normal usage
ledger under the reserved `redrouter-context-relay` system identity, preserving tenant,
provider, model, tokens and the request-time price snapshot without reserving or debiting the
client key that triggered the relay. A successful response without valid usage metadata is not
stored as a free summary. Other storage backends continue the summary path without this
SQLite-specific ledger entry until native usage accounting is generalized beyond SQLite.
Generation failure stays outside the client response path, and a missing summary still
produces a marker that explicitly forbids invented context.
The Rust-owned pipeline strategy now persists the dashboard's ordered per-target
instructions and optional transient retry policy. It executes each intermediate target
through the same provider authentication, translation, availability, breaker, load and
SQLite accounting controls as ordinary inference, threads the complete text into the next
target using the native Chat Completions, Responses, Anthropic or Gemini body shape, and
returns only the final target through the normal streaming/tool-capable proxy loop.
Intermediate failure is explicit and fail-closed; only 429/502/503/504 may consume the
configured bounded retry budget.
Rust also accepts explicit `{kind: "combo-ref", combo_id}` route entries and performs the
legacy flatten mode entirely inside the Rust snapshot builder. Expansion preserves declaration
order and fails closed on a missing/disabled dependency, tenant or protocol crossing, cycles,
more than three nesting levels, duplicate concrete targets, or an expansion beyond the native
eight-target bound. Configure and disable operations validate the prospective graph before the
database write, so an existing parent cannot be stranded by a partial mutation. The SPA reads,
creates and edits these references through the same Rust admin API. Nested `execute` mode and
weighted parent/reference semantics remain explicit follow-up work rather than silently changing
the child strategy.
The same path pre-generates a handoff when fresh provider/model session telemetry crosses the
configured warning threshold but remains below the 95% exhaustion boundary, using the quota
reset as the handoff expiry when available. The RedDB cross-process lease remains follow-up
work.
The remaining orchestration semantics remain explicit follow-up work rather than compatibility
calls back into Next.js.

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
