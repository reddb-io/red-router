# red-routerd: Rust production-backend migration

This crate is the target RedRouter server: proxy, control plane and durable persistence
move here while the dashboard becomes a static SPA. Feature parity is still incomplete,
so it must not yet be presented as a stable replacement release. It
implements OpenAI-compatible chat and embeddings, Cohere-compatible rerank, OpenAI Responses, native Anthropic Messages,
and native Gemini GenerateContent routes with a
required client key, separate provider keys, bounded request size and concurrent
streams, reusable HTTP connections, incremental responses, and safe redirect refusal.
Its authenticated `/v1/models` and `/api/v1/models` discovery endpoints list only routes
permitted for that client key, enrich configured targets from the active models.dev snapshot,
and emit the stable `X-RedRouter-Catalog-Version` cache-invalidation contract.
`/v1/models/{id}` returns one entry from that same scoped inventory (including provider-prefixed
IDs), while `/v1/models/info?id=...` projects its endpoint, context limits, modalities and
capabilities for RedCode without consulting the TypeScript server.
`/v1/catalog` groups that same scoped inventory for RedCode, while `/v1/capabilities` reports
only Rust-implemented routing behavior. `/v1/key` returns the authenticated persisted key's
redacted identity, role and model-ID format without building the model catalog; environment
fallback keys intentionally receive `401`. Successful provider responses include
`X-RedRouter-Served-Model` for the concrete target selected after fallback.
It binds only to loopback. The operator can configure supported protocol HTTPS
endpoints or literal-loopback HTTP mocks. It does not provide a public listener.
`RED_ROUTER_MAX_IN_FLIGHT` configures the process-wide simultaneous-request
capacity (default 64); it is separate from any per-key policy or usage quota.

It supports explicitly configured model aliases for OpenAI-compatible, native
Anthropic Messages and Gemini GenerateContent endpoints,
priority, fill-first, round-robin, weighted, random, strict-random, least-used,
power-of-two-choices, cost-optimized, context-optimized, reset-aware, reset-window,
headroom, quota-weighted or last-known-good selection, opt-in
fallback, and basic per-key route and model restrictions. It does not yet implement
RedRouter's full provider selection, automatic quota collection, policies, accounting, protocol
full protocol translation, remote listening or inbound TLS.
Its Rust-owned control plane now persists encrypted provider configurations and
applies provider changes without restarting. It also owns durable client-key hashes,
revocation, expiry, inference scopes, endpoint/model/provider grants and per-key
concurrency/request limits. The remaining policy and accounting domains still have
compatibility paths. An opt-in mode can
read a supported OpenAI-compatible API credential from the product SQLite database, as described
below. No product database migration is performed.
It has not been validated as a production gateway. `/healthz` confirms that this
process responds. `/readyz` additionally requires an active provider when the Rust
control plane is enabled.

## Rust-owned provider, client-key and combo control plane

Set `RED_ROUTER_ADMIN_KEY` (32–512 bytes) and `STORAGE_ENCRYPTION_KEY` (16–512
bytes) to enable the management API. `RED_ROUTER_CLIENT_KEY` is an optional migration
fallback until the first durable client key is created; after that, only Rust-owned
keys are accepted. If it is omitted, the empty database starts with an unobservable
random fallback and inference remains closed until a key is created. On an empty database, `RED_ROUTER_UPSTREAM_URL`,
`RED_ROUTER_PROVIDER_KEY` and optional `RED_ROUTER_PROVIDER_NAME` seed the first
provider; subsequent provider changes do not require those environment secrets.

- `GET /api/admin/providers` lists redacted provider metadata.
- `PUT /api/admin/providers/{id}` accepts `provider`, `upstream_url`, `api_key`
  and optional `tenant_id`, `enabled` and `rate_limit_scope` (`auto`, `connection`
  or `model`). New records default to tenant `red`; ownership is immutable after
  creation and is returned as redacted provider metadata.
- `DELETE /api/admin/providers/{id}` disables that provider and activates the
  most recently updated remaining enabled provider.
- `GET /api/admin/tenants` lists the Rust-owned organizations. A fresh store contains
  the enabled `red` tenant.
- `PUT /api/admin/tenants/{id}` creates or updates an organization with a stable ID,
  unique operator-facing slug, display name and enabled state. The default `red` tenant
  cannot be disabled. Disabling another tenant atomically removes all of its keys from
  the live authentication snapshot without deleting their audit metadata.
- `GET /api/admin/identity-bindings` and `PUT /api/admin/identity-bindings/{id}` map a
  verified `oidc:` subject to an enabled tenant and one of `admin`, `tenant-admin` or
  `issuer`. OIDC authentication alone grants no management authority; a durable enabled
  binding is required. `admin` is global. `tenant-admin` can list and mutate providers,
  combos and client keys only inside its bound tenant and can read the shared model catalog;
  omitted ownership defaults to that bound tenant. `issuer` remains limited to the scoped
  provisioning endpoint. The bootstrap administrator remains the recovery identity.
- `PUT /api/provision/client-keys/{id}` is the tenant-scoped service integration. It
  requires an explicit `tenant_id` and caller-generated `api_key`, so a RedDB Cloud retry
  can safely repeat the same stable key ID and secret without the router retaining plaintext.
  Tenant issuers cannot take over an existing key from another tenant.
- `GET /api/admin/client-keys` lists redacted key metadata and grants.
- `POST /api/admin/client-keys` generates a cryptographically random `rrk_` client key,
  persists only its SHA-256 lookup hash and returns the raw secret once with `Cache-Control:
  no-store`. The required `label` is durable operator metadata and may describe the workload
  that receives the key; it does not grant access by itself. Optional `tenant_id` binds
  the key to an enabled Rust-owned tenant and defaults to `red`. `created_by` is derived
  from the authenticated bootstrap administrator or verified OIDC subject, never from
  request JSON.
- `PUT /api/admin/client-keys/{id}` creates or replaces a key policy. `api_key` is
  required on creation and may be omitted on later policy updates. Optional
  `model_id_format` is `prefixed` (default) or `flat`; omitting it on an update
  preserves the committed value. With the default SQLite backend, native keys may
  also set `max_tokens_per_minute`, `max_tokens_per_day`,
  `max_spend_per_month_usd`, `reservation_tokens` and
  `reservation_spend_usd`. Reservation values are conservative per-provider-attempt
  bounds and are required when a corresponding quota is enabled.
- `DELETE /api/admin/client-keys/{id}` immediately revokes the key.
- `GET /v1/key` and `/api/v1/key` return only the caller's persisted key identity. The
  dashboard SQLite compatibility reader preserves its configured `flat` or `prefixed`
  model-ID format; Rust-owned keys return their own durable setting.

Native SQLite quotas are enforced entirely by Rust. Every attempt acquires a durable
`BEGIN IMMEDIATE` reservation before dispatch; independent Rust processes sharing the
same file therefore cannot pass the same remaining budget concurrently. Successful
OpenAI-compatible chat and streaming responses atomically append to
`redrouter_usage_ledger`, update the weighted token window and release the reservation.
Streaming requires `stream_options.include_usage=true`; `[DONE]` is forwarded only after
settlement. A failed, interrupted, crashed or oversized attempt keeps its dispatched
reservation for explicit reconciliation rather than silently making budget available.
Money is stored as integer micro-USD. Prices come from the active exact-ID models.dev
snapshot, and spend-governed requests fail closed when catalog pricing is unavailable.
The operational ledger is SQLite-only for now; configuring native token/spend quotas on
RedDB or PostgreSQL is rejected instead of falling back to process-local counters.
- `GET /api/admin/combos` lists Rust-owned combo routes.
- `GET /api/admin/model-catalog` lists the active models.dev manifest, provider index and
  whether the generation is bundled or persisted. `GET /api/admin/model-catalog/{provider}`
  materializes one exact provider.
- `POST /api/admin/model-catalog/refresh` conditionally downloads the fixed models.dev feed,
  strips executable/credential fields, validates the complete transformed catalog and atomically
  persists then publishes one last-good snapshot. A 304 or failed refresh never replaces it;
  other Rust replicas observe the lightweight durable revision and publish the same validated
  generation without putting the catalog row on the inference path.
- `PUT /api/admin/combos/{id}` creates or replaces a combo with optional immutable
  `tenant_id` (default `red`) and `protocol`
  (`openai`, `openai-responses`, `openai-embeddings`, `cohere-rerank`, `anthropic`
  or `gemini`), `strategy` (`priority`, `fill-first`, `round-robin`, `weighted`, `random`,
  `strict-random`, `least-used`, `p2c`, `cost-optimized`, `context-optimized`,
  `reset-aware`, `reset-window`, `headroom`, `quota-weighted` or `lkgp`),
  `fallback`, `enabled`,
  and one to eight `{provider_id, model}` targets. Weighted targets require integer
  `weight` values from 1–100 that total exactly 100. `least-used` and `p2c` use
  provider-wide in-flight counters shared across live configuration snapshots; a
  streaming request remains in flight until its upstream body has been drained.
  `strict-random` uses every eligible target once before a new deck cycle and
  randomizes the remaining fallback order without consecutive primary repeats.
  `cost-optimized` requires `input_cost_per_million` and
  `output_cost_per_million` on every target and tries the lowest combined price
  first. `context-optimized` requires `context_window_tokens` and tries the
  largest context window first. These optional target fields are stored in the
  combo JSON and returned by the admin API, so strategy changes and restarts do
  not lose their metadata.

Provider and combo ownership is revision-coupled in the selected Rust database. A
partially committed ownership update makes the control-plane snapshot unavailable
instead of publishing ambiguous state. A combo may reference only enabled providers
owned by the same tenant. Durable client keys discover and execute only routes owned by
their own tenant, even when their model/provider grant lists are otherwise unrestricted;
legacy environment keys are confined to tenant `red`.
- `DELETE /api/admin/combos/{id}` disables the combo.
- `DELETE /api/admin/combos/{id}/lkgp` clears one learned last-known-good target.
- `GET /api/admin/provider-health` lists provider breaker state, failure counts,
  thresholds and retry windows without exposing credentials.
- `PUT /api/admin/provider-health/{id}` durably configures `failure_threshold`,
  `degradation_threshold` and `reset_timeout_ms` and applies them to the live
  provider without rebuilding routes.
- `DELETE /api/admin/provider-health/{id}` durably resets one provider breaker
  while preserving its configured thresholds and reset window.
- `GET /api/admin/provider-quotas` lists the current redacted quota observations.
- `PUT /api/admin/provider-quotas/{id}` publishes `session` and/or `weekly`
  `{remaining_percent, reset_at_unix_ms}` windows, optional `limit_reached`, and a
  bounded `ttl_seconds`. `DELETE` clears the observation immediately.
- `GET /api/admin/oidc` returns the redacted Rust-owned management authentication
  policy. `PUT` validates, fetches and verifies its JWKS before durably replacing
  the live policy; `DELETE` removes it. The payload contains `enabled`, `issuer`,
  `audience`, `jwks_uri`, `required_claims` and `allowed_subjects`.
- `GET /api/auth/config` is a cache-disabled, non-secret bootstrap for the static
  dashboard. `POST /api/admin/oidc/discover` performs authenticated, bounded and
  DNS-pinned standard issuer discovery and returns validated endpoints and scopes.

All management endpoints accept `Authorization: Bearer <RED_ROUTER_ADMIN_KEY>`.
After a valid enabled OIDC policy has been committed, their authorized subset also accepts an
asymmetrically signed OIDC JWT whose issuer, audience, expiry, required claims and
subject or verified e-mail match that policy. Every configured claim must match;
array claims match when at least one value is allowed. The admin key remains the
bootstrap and recovery credential, including after OIDC is deleted or unavailable.
The verifier accepts only RS256/384/512, PS256/384/512, ES256/384 and EdDSA, pins
validated DNS results, refuses redirects and system proxies, bounds token/JWKS sizes,
caches keys and throttles unknown-key refreshes. JWKS endpoints must use HTTPS except
for literal-loopback development servers. Browser login uses Authorization Code + PKCE
S256, encrypted state/nonce/verifier data, verified ID tokens, encrypted 12-hour sessions,
double-submit CSRF, same-origin Fetch Metadata/Origin validation and explicit logout.
The dashboard login/settings code can consume this Rust boundary. Set
`RED_ROUTER_SPA_DIR` to a prepared static dashboard build containing `index.html` and
Rust serves it on the same origin without a Next.js server. Startup fails for an invalid
directory. Browser navigation receives the SPA shell, but reserved API namespaces,
hidden paths and missing files with extensions never do. HTML and `sw.js` use `no-store`;
versioned `/_next/static/` chunks use immutable one-year caching. Brotli and gzip sidecar
files are selected when present. The server adds CSP, clickjacking, MIME-sniffing,
referrer, permissions and opener protections. Producing and packaging the complete
production dashboard export remains migration work.
Provider credentials are encrypted with a random salt and nonce, authenticated against their
provider ID, and never returned by the API. The durable database is updated before an
atomically replaced, DNS-pinned runtime target becomes visible. Invalid storage or
configuration fails closed. Client secrets are reduced to SHA-256 lookup hashes before
storage and are never returned. Supported client policy fields are `enabled`,
`expires_at_unix`, `scopes`, `allowed_endpoints`, `allowed_models`, `blocked_models`,
`allowed_provider_ids`, `max_concurrent_requests`, `max_requests_per_minute` and
`max_requests_per_day`. Combo writes are durable before an immutable, DNS-pinned routing
snapshot becomes visible. Once any combo row exists, Rust-owned combos are authoritative;
unknown or disabled aliases do not fall through to the active provider. Target
routing metadata and provider quota observations are durable; automatic quota polling,
catalog pricing, token/spend quotas and
the remaining dashboard settings still need migration.

Rust-owned providers share durable circuit breakers across aliases and live route
snapshots. Network failures and `408`, `500`, `502`, `503` and `504` count as
provider-wide failures. `401`, `403`, `429` and other account/model outcomes do not.
Local literal-loopback providers degrade/open after 1/2 failures with a 15 second reset;
other API-key providers use 7/12 failures with a 30 second reset. An open breaker is
skipped before dispatch, and only one half-open probe is admitted after cooldown.
The authenticated health API can override those defaults per provider. Configuration
survives restart and operator reset; the request path reads the existing live circuit
and does not perform a configuration database lookup.

Connection and model availability are persisted separately from the provider-wide
breaker. A bare API-key `401` from a known direct provider parks that connection as
`expired` until an authenticated operator resets its health. Generic and multiplexing
providers retain a bounded cooldown until their error body can be classified safely.
HTTP `402` parks a connection as `credits_exhausted`, or
only the affected model when the provider's effective `rate_limit_scope` is `model`.
The automatic scope keeps known multiplexing gateways model-local; an explicit scope
overrides it. `404` remains model-local and `429` follows the same configured scope.
These states survive restart, are visible in `GET /api/admin/provider-health`, and are
cleared with `DELETE /api/admin/provider-health/{id}`. A generic `403` is still a
bounded connection cooldown rather than an automatic permanent ban because many
providers use it for request-, entitlement- or region-specific refusals.

The `lkgp` strategy starts in dashboard order, learns the first successful target and
stores only `{combo_id, provider_id, model, revision}` in `redrouter_route_pins`. Later
requests read an atomic target index and do not query storage. SQLite/RedDB/PostgreSQL is
written only when the selected target changes or a pinned target fails. Pins survive a
restart, are exposed as redacted `last_known_good` metadata in combo listings, and are
removed when the combo, provider target or strategy no longer matches.

## Experimental product SQLite credential

### Experimental FastLLM transport for dashboard priority combos

For supervised local operation, set `RED_ROUTER_FASTLLM_MANAGED_BINARY` to
the patched FastLLM executable along with `RED_ROUTER_PRODUCT_DB_PATH`,
`RED_ROUTER_PRODUCT_COMBO` and `RED_ROUTER_PRODUCT_CLIENT_KEYS=1`. The gateway
creates two independent random internal tokens, starts an authenticated
loopback control source and FastLLM, and waits until FastLLM reports the exact
expected snapshot before listening for client traffic. That snapshot is also
compared with the endpoints and credentials captured by the gateway, so a
configuration that changes and changes back during startup is not silently
accepted. It restarts the engine
up to three times after exits and stops if the control source fails. The child
does not inherit the dashboard encryption key. Do not combine managed mode
with `RED_ROUTER_FASTLLM_URL`, `RED_ROUTER_FASTLLM_INTERNAL_KEY` or
`RED_ROUTER_FASTLLM_CONTROL_TOKEN`.

The supervised engine disables internal backend retries and retries on failed
pooled sends: a provider may have received a request even when its response is
lost. The gateway may still perform its own configured fallback, subject to its
separate admission rules. Rebuild the patched FastLLM executable after updating
the integration patch. Concurrent token and spend admission can be enabled with
the strict and concurrent quota settings documented below. The one-at-a-time
legacy strict mode remains refused for FastLLM.

On Unix, normal SIGTERM drains the gateway and terminates its FastLLM child.
A force-killed or crashed parent can still leave an orphan child; use a
service manager or container process group that terminates all descendants.

Managed FastLLM does not poll for snapshot changes. The gateway checks its
captured combo and connection state before dispatch and also watches for
changes. When configuration changes, it stops accepting new traffic, allows
up to 30 seconds for active requests to drain, then starts a new gateway and
engine with a freshly verified snapshot and new internal tokens. Requests that
are still active after the grace period can be interrupted. While a changed
configuration is invalid, the gateway remains unavailable and retries.
This is a local experimental mode and has not been validated with real
provider credentials.
Managed mode requires `RED_ROUTER_PRODUCT_CONCURRENT_QUOTAS=1` whenever
`RED_ROUTER_PRODUCT_STRICT_QUOTAS=1` is enabled. Each gateway attempt reserves
its configured token and USD upper bounds in SQLite before calling FastLLM.
The patched engine disables its hidden retries, completed usage is settled by
the gateway, and an uncertain or failed attempt retains its reservation for
reconciliation. TypeScript System One uses the same reservation cycle; ordinary
TypeScript chat must still block these governed keys.

With `RED_ROUTER_PRODUCT_DB_PATH`, `RED_ROUTER_PRODUCT_COMBO` and
`RED_ROUTER_PRODUCT_CLIENT_KEYS=1`, an operator may additionally set
`RED_ROUTER_FASTLLM_URL` to a literal loopback HTTP
`/v1/chat/completions` endpoint and `RED_ROUTER_FASTLLM_INTERNAL_KEY` to a
separate, secret 32–512 character internal token. This opt-in mode supports
simple priority combos of up to eight targets with distinct upstream model
names. Red Router checks the dashboard key,
supported policies, combo and selected connection before forwarding. Existing
shared RPM and optional accounting paths remain in the Red Router process;
this mode does not add support for quota types or policies they do not handle.

FastLLM must be independently configured to accept the internal token and
resolve each combo _upstream model name_ to the same provider and connection
selected in SQLite. Red Router tries permitted targets in priority order on its
existing pre-stream fallback path. The Red Router process cannot yet verify that mapping or
provision, rotate or revoke the credential in FastLLM. Limit the FastLLM
listener to loopback and give it no public client keys. Whoever has the
internal token can bypass the dashboard gate. The tested upstream FastLLM
HTTP control source also caches snapshots containing provider credentials on
disk and retains stale snapshots on control-plane failure. Do not use this
experimental mode with real secrets or production traffic until those gaps are
fixed. It adds a loopback hop; no performance improvement is implied.

An experimental alternative to manually provisioning FastLLM credentials is
`red-routerd fastllm-control`. It reads `RED_ROUTER_PRODUCT_DB_PATH`,
`RED_ROUTER_PRODUCT_COMBO`, `RED_ROUTER_FASTLLM_INTERNAL_KEY`, a **different**
`RED_ROUTER_FASTLLM_CONTROL_TOKEN`, and optionally `STORAGE_ENCRYPTION_KEY`.
Its `RED_ROUTER_FASTLLM_CONTROL_LISTEN` defaults to `127.0.0.1:19092` and is
restricted to loopback. Both FastLLM tokens must be independent, unpredictable
secrets of at least 32 characters; they may not match a product key.

The corresponding FastLLM must be built at the pinned commit with
`scripts/patches/fastllm-memory-only.patch`, started on loopback with
`--control-url http://127.0.0.1:19092/snapshot --redrouter-memory-only`, and
given the control token through `FASTLLM_PROXY_TOKEN`. The patch disables both
reading and writing the HTTP snapshot cache. The control endpoint requires a
bearer token and the patch's memory-only request marker before returning a
snapshot. The marker prevents an ordinary unmodified FastLLM from accidentally
downloading credentials; a caller that knows the control token can forge it.
Snapshot bytes and decrypted credentials exist in process memory and travel
over loopback HTTP. This is an experimental local trust boundary, not protection
against a local process that has access to those tokens or process memory.

The source supports the same simple OpenAI-compatible priority combos as the
guarded transport. Configuration edits and credential revocations make new
snapshot requests fail until restart; the FastLLM can retain its previous
in-memory snapshot, so every client request must continue through the guarded
Red Router listener. The control source does not handle FastLLM usage reports
or implement token/spend quota reconciliation. It does not yet automatically
launch or supervise FastLLM, and has not been validated with real credentials.
When using the separately launched control source instead of supervised mode,
restart the gateway, control source and FastLLM together when changing a combo
or credential. Snapshot versions are content
fingerprints, not timestamps, so FastLLM metrics that interpret them as a
timestamp must not be used for snapshot age in this mode.

Set `RED_ROUTER_PRODUCT_DB_PATH` to the existing product `storage.sqlite` file,
`RED_ROUTER_PRODUCT_CONNECTION_ID` to the ID of an active supported API-key
connection. Unless using dashboard keys below, set `RED_ROUTER_CLIENT_KEY` to
a separate strong client key. If the
provider credential uses field encryption, provide the same
`STORAGE_ENCRYPTION_KEY` that the webapp uses through the process environment.
Only the current `enc:v1` static-salt format and plaintext credentials are
supported; legacy encrypted credentials require migration by the webapp first.

By default this mode opens the product database read-only, uses the provider's fixed HTTPS
endpoint, and rechecks the selected connection before each request. Edits,
deactivation, removal or database errors stop new requests until restart; requests
already forwarded can still finish. By default it does not modify the existing database and
does not use `RED_ROUTER_PROVIDER_KEY`, model route JSON or the separate gateway
database. By default, inbound authentication and optional policy JSON remain
independent; dashboard keys may instead be enabled as described below. Product
most product routing strategies and other connection settings are not enforced.
Per-request database checks add overhead; this mode needs its own benchmarks.

Set `RED_ROUTER_PRODUCT_CLIENT_KEYS=1` to use dashboard API keys instead of an
independent client key. Do not set `RED_ROUTER_CLIENT_KEY` or environment client
policies in that mode. The gateway reads the current key on each request, accepts
plain or SHA-256-hashed product keys, rejects revoked, disabled, banned and expired
keys, and enforces the supported model, endpoint and selected-connection restrictions.
It rejects unsupported wildcards and policies instead of ignoring them.

This is an intentionally narrow compatibility slice, not full dashboard policy
enforcement. It refuses keys with configured request limits, usage caps, quota
pools, token limits, budgets, group membership, schedules or other unsupported
restrictions and model deny-lists (which require product alias resolution). It
also refuses configured budget assignments, model-to-combo mappings and global
disabled-model lists; quota routes do not work. A restricted dashboard combo
mode is described below.
Missing expected schema fails closed. No usage or cost accounting is recorded by
default. Provider choice is an explicit connection ID unless the limited
startup selection below is enabled.
Only direct chat and OpenAI-compatible embedding requests to fixed endpoints for OpenAI, OpenRouter, Groq,
Mistral, DeepSeek, Together, Perplexity, Fireworks, Cerebras and SambaNova are supported in
this mode. The requested model must start with the selected product provider,
for example `openrouter/openai/gpt-4o` or `openai/gpt-4o`; the provider prefix
is removed before forwarding. Do not use it as a production replacement.

As an experimental alternative to `RED_ROUTER_PRODUCT_CONNECTION_ID`, set
`RED_ROUTER_PRODUCT_PROVIDER` to `openai`, `openrouter`, `groq`, `mistral`,
`deepseek`, `together`, `perplexity`, `fireworks`, `cerebras`, or `sambanova`. Fireworks currently
requires a complete `accounts/fireworks/models/...` or
`accounts/fireworks/routers/...` identifier; shorthand expansion is not yet
implemented. Startup then
selects the active connection with the dashboard's fill-first priority order.
The selected connection is fixed until restart. Other configured routing
strategies and unsupported connection health, proxy, concurrency or quota
settings fail startup. This is not full per-request dashboard account selection.

With automatic selection and dashboard client keys, set
`RED_ROUTER_PRODUCT_ACCOUNT_FALLBACK=1` to enable bounded fallback among up to
eight additional API-key connections of the same provider. Before an alternative
is used, its state and the key's connection and model permissions are rechecked.
On a transport failure, 429, or 5xx, the proxy can submit the request to another
account before starting the response; this can repeat a request and incur
duplicate charges. A single client RPM reservation covers the fallback attempts.
The connection list is loaded at startup; configuration changes require restart.
This does not implement cross-provider combos, all product routing strategies,
or fallback after a response starts streaming.

Alternatively set `RED_ROUTER_PRODUCT_COMBO` to a dashboard combo name,
`RED_ROUTER_PRODUCT_CLIENT_KEYS=1`, and omit the provider and connection
selection variables. This experimental mode reads one stored priority combo and
selects fill-first API-key connections for supported provider targets. The
new provider mappings are fixture-tested only; they do not establish full
model-specific behavior or live-provider compatibility.
It verifies the combo, key, permitted models and each connection before use;
changes to the stored combo or selected connections require a restart. Only
simple priority model steps with empty combo configuration are supported.
Nested combos, provider wildcards, pinned connections, per-step prompts, and
other strategies or settings are rejected. Fallback may submit the prompt to
multiple providers. The selected combo does not import the rest of the dashboard.

Set `RED_ROUTER_PRODUCT_SHARED_RPM=1` with dashboard client-key mode to enable
the product's requests-per-minute quota. This opens the existing SQLite file for
writing and reserves one request in `api_key_quota_counters` before forwarding,
using the product's two-bucket weighted window. Independent Rust processes
using the same local SQLite file coordinate reservations transactionally. They
also observe counters written by the existing proxy. A reservation is counted
even if forwarding subsequently fails or the client disconnects.

Enable `RED_ROUTER_PRODUCT_SHARED_RPM=1` in the TypeScript process as well,
pointed at the same local product SQLite file, to reserve RPM atomically across
both implementations. TypeScript records successful token usage separately and
does not increment RPM a second time for a request already reserved. A process
running without this setting retains the older check-before/increment-after
behavior, so mixed traffic with that process can still exceed the limit.

By default token, daily and monthly spend quotas, and other request limits remain
unsupported by Rust and block requests when configured. SQLite is not a
distributed database; do not assume separate node-local files or network-mounted
files share safe cluster coordination. Keep the mode experimental.
For experimental recording of completed OpenAI-compatible chat and embedding
responses, opt in with `RED_ROUTER_PRODUCT_ACCOUNT_USAGE=1` and product client
keys. Each target must have explicit numeric `input`, `output`, `cached`,
`cache_creation`, and `reasoning` prices in the dashboard's user pricing for
that exact provider and model. Every priced ledger row freezes the complete
recording-time price breakdown in `pricing_snapshot`, so later pricing edits do
not rewrite historical meaning.

Set `REDROUTER_USAGE_REPORT_ALL_REQUESTS=true` to also record completed chat,
streaming and embedding calls whose exact model price cannot be resolved. These rows retain
their token counts with `pricing_known=0`, zero numeric cost fields and a null
price snapshot; zero is a storage placeholder and must not be interpreted as a
free model. Without this flag, unresolved pricing still fails closed. Strict
token/spend quota mode always requires explicit pricing even when reporting all
requests is enabled.

`REDROUTER_USAGE_ATTRIBUTES_JSON` adds validated instance/operator metadata to
every Rust usage row. Immutable per-key attributes from the dashboard are merged
at authentication time and snapshotted into `usage_attributes` for chat,
streaming, embeddings and any durable reservation requiring reconciliation. The
Rust proxy enforces the dashboard limits of 32
scalar fields, lowercase identifier names and 256 UTF-16 code units per string;
attribute names that can contain credentials (including secrets, passwords,
tokens, authorization, credentials or API keys) are rejected. A conflicting
instance/key value fails closed instead of silently changing attribution.

Streaming requires `stream_options.include_usage`
to be true; non-default service tiers are rejected. In streaming mode the
proxy drains the provider even if the client disconnects and forwards the final
`[DONE]` only after recording usage. A successful response without valid usage or a failed
SQLite write is returned as an error; the provider may still charge for it.
Each upstream attempt creates a durable reservation before sending. A completed
response atomically writes its usage and releases its reservation. An interrupted
upstream response, failed attempt, process crash, or provider failure can have
unrecorded cost and leaves an unresolved dispatched reservation for reconciliation;
these reservations never expire automatically. This mode does not apply token or
spend quotas by default. The TypeScript System One path participates in the
same reservation protocol when concurrent strict quotas are enabled; ordinary
TypeScript chat requests remain blocked for governed keys.

For a restricted trial of per-key TPM, daily-token and monthly-USD quotas, set
`RED_ROUTER_PRODUCT_STRICT_QUOTAS=1`, `RED_ROUTER_PRODUCT_RESERVE_TOKENS` and
`RED_ROUTER_PRODUCT_RESERVE_USD` in the Rust process, in addition to product
client keys, usage accounting and shared RPM. The token and USD values are
conservative upper bounds for one provider attempt; a request is refused if the
bound cannot fit. Only one attempt per key may be outstanding, and an uncertain
or oversized response requires reconciliation. An attempt costing more than its
configured bound can itself exceed a quota before its usage is observed; this
is not a hard spending guarantee. Independently governed budgets, per-model
token limits and other unsupported policies still block in Rust.

`RED_ROUTER_PRODUCT_CONCURRENT_QUOTAS=1` opts into parallel reservations for the
same key, limited by the configured remaining quota instead of the one-at-a-time
gate. Direct Rust, supervised patched FastLLM, and TypeScript System One use this
protocol. Each actual provider attempt reserves the full configured token and USD
bounds. These values must be genuine per-attempt upper bounds: an underestimated
bill can exceed the quota before it is observed, and its reservation is then
quarantined. An interrupted attempt keeps its reservation until reconciled.
Ordinary TypeScript chat still blocks quota-governed keys in strict mode until
its retry and streaming paths participate. This opt-in is not a hard spending
guarantee.

Enable both `RED_ROUTER_PRODUCT_STRICT_QUOTAS=1` and
`RED_ROUTER_PRODUCT_SHARED_RPM=1` in **every** TypeScript process using the same
SQLite file. TypeScript then refuses ordinary chat requests for keys with these
token or spend quotas; send those requests to the Rust proxy. System One may use
them when concurrent quotas and reservation bounds are also configured. Other
TypeScript requests continue as before. Existing processes without these settings
or the updated code can still bypass this mode. Drain existing requests before
enabling it. Every fallback after an uncertain attempt consumes a separate
reservation until the uncertain attempt is reconciled.

With `RED_ROUTER_PRODUCT_DB_PATH` set, run `red-routerd list-usage-reservations`
to inspect up to 1,000 outstanding attempts. For a dispatched attempt, verify
the actual usage and completion time with the provider before running
`red-routerd reconcile-usage <reservation-id> <usage.json>`. The JSON file must
contain `timestamp_ms` (UTC Unix milliseconds) and an OpenAI-compatible `usage`
object with `prompt_tokens` and `completion_tokens`; include supported token
details when present. Reconciliation uses the price and attribution snapshots
from dispatch and atomically records usage before clearing the reservation. Only
use zero tokens
when the provider has confirmed that no usage occurred. Entries lacking the
provider, model or price snapshot cannot be reconciled by this command.

`red-routerd cancel-undispatched <reservation-id>` removes only an entry that
has not been marked dispatched; it cannot release an uncertain provider attempt.

```sh
export RED_ROUTER_LISTEN=127.0.0.1:19091
export RED_ROUTER_UPSTREAM_URL=http://127.0.0.1:19090/v1/chat/completions
export RED_ROUTER_CLIENT_KEY=replace-with-at-least-16-random-bytes
export RED_ROUTER_PROVIDER_KEY=mock-provider-key
cargo run --release --manifest-path rust/red-routerd/Cargo.toml
```

## Experimental database selection

The default is SQLite, using `red-router.sqlite` in the working directory. Set
`RED_ROUTER_DATABASE_URL` to a SQLite URL to choose another file, or select a
different backend explicitly using `RED_ROUTER_DB_BACKEND` and a matching URL:

| Backend         | `RED_ROUTER_DB_BACKEND` | `RED_ROUTER_DATABASE_URL`                        |
| --------------- | ----------------------- | ------------------------------------------------ |
| SQLite embedded | `sqlite`                | `sqlite:///absolute/path/router.sqlite?mode=rwc` |
| RedDB embedded  | `reddb-embedded`        | `file:///absolute/path/red-router.rdb`           |
| RedDB remote    | `reddb-remote`          | `reds://user:password@host:5050`                 |
| PostgreSQL      | `postgres`              | `postgresql://user:password@host:port/database`  |

Remote RedDB uses RedWire. `reds://` enables TLS with the bundled public WebPKI roots;
`red://` is plaintext. Set `?ca=/absolute/path/ca.pem` on a `reds://` URL to trust a
private CA. Authentication can be supplied as URL user/password or `?token=...`.
Authenticated RedWire requires a server with the native-listener authentication
fix, available in RedDB 1.28.15 and later. Upgrade affected remote servers before
relying on that authentication boundary.
Database connection strings can
contain credentials; do not commit or log them. A selected backend that is
unavailable causes startup to fail, with no automatic switch to a local database.
RedDB's known concurrent indexed-read issue remains under investigation; these
settings are not yet suitable evidence of safe clustered operation.

An existing `red-router.rdb` from the previous default is not migrated. If it is
present and the default SQLite file is absent, startup requires an explicit backend
selection or database URL before creating a new authority. Set
`RED_ROUTER_DB_BACKEND=sqlite` to start a new SQLite database, or select
`reddb-embedded` and use a build with the feature enabled to keep using RedDB.

On the first run against an empty database, `RED_ROUTER_UPSTREAM_URL` is validated
and saved. On later runs the stored value wins over this initial seed. To change it,
set the environment variables as above and run the binary with `set-upstream`;
restart each proxy process to apply the change. Stop the proxy first when editing an
embedded RedDB file: one RedRouter process can own that file at a time. This slice does not implement
distributed configuration invalidation or database-backed provider credentials.
The default build omits the embedded RedDB engine. Build with
`--features reddb-embedded` to select embedded RedDB; choosing it in the default
build fails. Remote RedDB remains available without that feature.

For an OpenAI-compatible provider, set `RED_ROUTER_UPSTREAM_URL` to its complete
HTTPS chat-completions URL, `RED_ROUTER_PROVIDER_KEY` to its credential, and
`RED_ROUTER_CLIENT_KEY` to a different strong random key. Do not commit or log keys.
DNS answers are checked and pinned at startup; restart to pick up DNS changes.
Private HTTPS targets require `RED_ROUTER_ALLOW_PRIVATE_UPSTREAM=1`. Cloud metadata
and link-local addresses remain blocked. HTTP is allowed only for literal loopback.
Redirects are refused. System proxy environment settings are deliberately ignored.

## Experimental model routes

`RED_ROUTER_ROUTES_JSON` optionally configures model aliases and OpenAI-compatible
providers. The single database-backed endpoint and `RED_ROUTER_PROVIDER_KEY` remain
required at startup. Route definitions are environment-only and are not read from
the existing dashboard or persisted to the selected database. Provider keys remain
in the named environment variables, never in the JSON:

```sh
export OPENAI_KEY='...'
export OPENROUTER_KEY='...'
export RED_ROUTER_ROUTES_JSON='[
  {"model":"my-combo","strategy":"round-robin","fallback":true,"targets":[
    {"url":"https://api.openai.com/v1/chat/completions","model":"gpt-4.1-mini","api_key_env":"OPENAI_KEY"},
    {"url":"https://openrouter.ai/api/v1/chat/completions","model":"openai/gpt-4.1-mini","api_key_env":"OPENROUTER_KEY"}
  ]}
]'
```

An unrecognized model is rejected when routes are configured. `priority` selects
the first target; `round-robin` rotates per process. Both default to one attempt.
With `fallback: true`, a connection failure, header timeout, HTTP 429, or HTTP 5xx
tries the next target before streaming begins. This can submit the same prompt to
multiple providers and can incur duplicate charges; enable it deliberately. A 4xx
other than 429 and a redirect do not trigger fallback. Stream failures after headers
are sent are not retried. Model aliases, provider routing, and strategies are a
small experimental subset and do not provide full RedRouter combo, access, quota,
billing, or data-handling compatibility.

For an OpenAI Chat Completions client targeting Anthropic Messages,
configure an explicit `"protocol":"openai-to-anthropic"` route with a target URL
ending in `/messages`. The adapter supports text messages, function tools and tool
results, translates JSON and incremental SSE text/tool responses and token usage,
and defaults `max_tokens` to 4096 if omitted. Unsupported request fields, multimodal
content and unsupported response blocks fail instead of being silently omitted.
An interrupted or unsupported upstream stream terminates without a `[DONE]` marker.
This limited
adapter is not yet equivalent to RedRouter's existing protocol translators.

An environment-configured OpenAI chat route may also mix OpenAI-compatible
targets with an Anthropic Messages target by setting
`"protocol":"openai-to-anthropic"` on that target. The request must be
translatable before any target is called; unsupported fields are rejected rather
than dropped during fallback. JSON and SSE responses from the Anthropic target
are translated back to OpenAI format. This remains environment configuration;
dashboard-defined combos use the separate restricted mode described above.

Anthropic and `openai-to-anthropic` targets use `x-api-key` by default. For an
Anthropic-compatible provider requiring Bearer authentication, such as the
[OpenRouter Messages API](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages),
set `"auth":"bearer"` on that target. The provider key still comes only from
the target's named environment variable.

Native Anthropic Messages can be configured as a separate route:

```sh
export ANTHROPIC_KEY='...'
export RED_ROUTER_ROUTES_JSON='[{"model":"claude-route","protocol":"anthropic","targets":[{"url":"https://api.anthropic.com/v1/messages","model":"your-anthropic-model","api_key_env":"ANTHROPIC_KEY"}]}]'
```

Send native requests to `/v1/messages` with the proxy client key in `x-api-key`
(or an Authorization bearer header). The proxy forwards `anthropic-version`
(default `2023-06-01`) and `anthropic-beta`, and streams the native response.
Each route has one protocol; OpenAI and Anthropic requests cannot be interchanged.

For native OpenAI Responses, configure a distinct route with
`"protocol":"openai-responses"` and a target URL ending in `/v1/responses`.
Send requests to `/v1/responses` with the proxy bearer key and an explicit
`model` matching that route. JSON and server-sent events are relayed without
translation; retrieval, cancellation and other Responses endpoints are not yet
implemented. See the [official streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses).

Native Gemini GenerateContent supports both JSON and SSE responses:

```sh
export GEMINI_KEY='...'
export RED_ROUTER_ROUTES_JSON='[{"model":"gemini-route","protocol":"gemini","targets":[{"url":"https://generativelanguage.googleapis.com/v1beta/models","model":"your-gemini-model","api_key_env":"GEMINI_KEY"}]}]'
```

Send a native Gemini request body to `/v1beta/models/gemini-route:generateContent`
or `/v1beta/models/gemini-route:streamGenerateContent?alt=sse`, using the proxy
client key in `x-goog-api-key` or an Authorization bearer header. The provider key
is supplied separately from the named environment variable. Only `alt=sse` is
accepted in the query string, only for streaming; credentials in query strings and
model overrides in the JSON body are rejected. Route and target model names are
single path segments. Native bodies and responses pass through without protocol
translation. This is Gemini API support; Gemini CLI provider authentication is not
implemented. See the [Gemini REST API reference](https://ai.google.dev/api/generate-content).

OpenAI-compatible embeddings use a separate `"protocol":"openai-embeddings"`
route with a target URL ending in `/embeddings`. Send a JSON request with the
route alias as `model` to `/v1/embeddings`; the proxy substitutes the target
model and passes the input and provider response through. This requires an
explicit route and does not implement translation to other embedding APIs.

For Cohere-compatible reranking, configure a separate `"protocol":"cohere-rerank"`
route with a target URL ending in `/rerank`, such as `https://api.cohere.com/v2/rerank`.
Send a JSON request with the route alias as `model` to `/v1/rerank`. The proxy
substitutes the target model and relays the remaining body and response unchanged.
Provider-specific adaptations for non-Cohere request or response formats are not
implemented. See the [Cohere rerank API](https://docs.cohere.com/v2/reference/rerank).

## Experimental client policies

`RED_ROUTER_CLIENT_POLICIES_JSON` replaces the default client credential with
explicit per-key policies. Each key is read from the named environment variable;
never put a key in the JSON. Without this setting, the original
`RED_ROUTER_CLIENT_KEY` continues to have unrestricted access.

```sh
export AGENT_CLIENT_KEY='replace-with-a-random-client-key'
export RED_ROUTER_CLIENT_POLICIES_JSON='[
  {"api_key_env":"AGENT_CLIENT_KEY","allowed_routes":["my-combo"],
   "allowed_models":["vendor/*"],"allowed_endpoints":["chat"],"blocked_models":["vendor/restricted-model"],"max_concurrent_requests":4,"max_requests_per_minute":60,"expires_at_unix":2000000000}
]'
```

`allowed_routes` restricts the requested model or route alias; omitting it allows
all, while an empty array denies all. `allowed_models` optionally restricts the
upstream target model names before selection or fallback; without configured routes
it restricts the requested model directly. Omitting it allows all targets, while an
empty array denies all. `blocked_models` denies matching requested models and filters
matching upstream target model names before selection or fallback. Rules are exact, `*`, or a namespace prefix ending in `/*`.
`allowed_endpoints` uses the existing RedRouter endpoint categories. All native
proxy generation endpoints are in `chat`, `/v1/embeddings` is in
`embeddings`, and `/v1/rerank` is in `rerank`; an omitted or empty list permits all
categories. `enabled: false` disables a key. Unknown fields, missing keys, duplicate keys,
and malformed rules fail startup. `expires_at_unix` optionally sets an exclusive
expiration time in Unix seconds, checked on each request; it does not terminate
an active stream. This environment-only format does not import the dashboard's
timestamp configuration. `max_concurrent_requests` optionally limits each
key to 1–64 concurrent requests within this process; a stream holds its slot until
it finishes or is dropped. A busy key receives HTTP 429. Changes apply after restart. These policies are
local to this experimental process and do not import existing dashboard settings,
per-key budgets, quotas, schedules, provider-account restrictions or distributed
rate limits. Do not assume policy parity with the current RedRouter.

`max_requests_per_minute` and `max_requests_per_day` optionally limit a key to
1–10,000 admitted requests per rolling 60-second or 24-hour window, respectively.
When both are set, both must allow the request. Requests rejected before routing do not count;
fallback attempts for one request count once. The limit returns HTTP 429 when full,
is held in this process's memory, resets on restart, and is not shared between
multiple proxy instances.

For OpenRouter, use `https://openrouter.ai/api/v1/chat/completions` as the upstream
URL and an OpenRouter API key as the provider key. For example, after starting the
server with those settings, a client can send a small test request:

```sh
curl http://127.0.0.1:19091/v1/chat/completions \
  -H "Authorization: Bearer $RED_ROUTER_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openrouter/free","messages":[{"role":"user","content":"Say hello"}],"max_tokens":16}'
```

`openrouter/free` is OpenRouter's free-model router, subject to its availability
and rate limits. See the [OpenRouter API documentation](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request).

The explicitly dispatched `live` suite in the optional quality workflow uses the
`OPENROUTER_API_KEY` GitHub Actions secret to call `openrouter/free` through the
actual SQLite-backed gateway in both JSON and streaming modes, using the native
OpenAI-compatible endpoint and the OpenAI-to-Anthropic translation route. It is not included
in the normal CI suites. The test logs neither the key nor the provider response;
it requires network access and a valid key, and may fail when the free router is
unavailable or rate-limited.

The next slice needs equivalent routing/authz, accounting, persistence and contract
tests before considering a cluster deployment.
