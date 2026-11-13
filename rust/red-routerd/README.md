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
priority, automatic, fill-first, round-robin, weighted, random, strict-random, least-used,
power-of-two-choices, cost-optimized, context-optimized, cache-optimized, context-relay,
fusion, pipeline, reset-aware, reset-window, headroom, quota-weighted or last-known-good selection, opt-in
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
provider; `RED_ROUTER_PROVIDER_AUTH_SCHEME`, `RED_ROUTER_PROVIDER_LABEL`,
`RED_ROUTER_PROVIDER_ACCOUNT_EMAIL` and `RED_ROUTER_PROVIDER_EXPIRES_AT_UNIX` can
describe that bootstrap connection. Subsequent provider changes do not require
those environment secrets. `RED_ROUTER_PROVIDER_PROTOCOL` optionally selects the
bootstrap connection protocol; it has no effect on an already saved provider.

- `GET /api/admin/provider-nodes` and `PUT`/`DELETE /api/admin/provider-nodes/{id}`
  manage tenant-owned reusable API definitions: `name`, `prefix`, explicit `protocol`,
  `base_url`, optional `chat_path` and `models_path`. Paths append to the base URL;
  default inference paths follow the chosen protocol and model discovery defaults
  to `/models`. Prefixes cannot shadow catalog or historical executor identities.
  SQLite/PostgreSQL enforce unique prefixes within a tenant. Linked accounts block
  deletion. Endpoint/protocol/prefix edits with linked accounts require
  `apply_to_connections:true`; this intentionally reuses each account's encrypted
  credential at the approved endpoint, after URL/auth/combo compatibility checks.
  Per-connection custom headers detach on transport identity changes.
- Provider creation accepts `node_id` instead of repeating `provider`, `upstream_url`
  and `protocol`. These values are inherited in runtime snapshots and after restart.
  Omitted `node_id` preserves an existing binding; `null` detaches it and requires
  explicit standalone settings and the credential again. OAuth connections cannot
  bind to API definitions. Model discovery inherits the definition unless overridden
  on the account. Legacy node import, preset/media settings, model CRUD and
  model-prefix routing aliases are separate pending capabilities.
  The linked-account check is serialized within one control plane; distributed
  create/delete races and non-SQL namespace uniqueness still need dedicated acceptance.
- `GET`/`PUT /api/admin/provider-nodes/{id}/headers` manage encrypted shared header
  defaults. GET exposes names/revision/attachment only; PUT replaces the map and an
  empty map removes it. Account headers override matching names case-insensitively;
  clearing an account map restores inherited defaults. Each map permits 16 headers,
  so the merged snapshot has at most 32. Authentication, framing and forwarding
  names remain reserved. Endpoint/protocol/prefix changes detach stored shared values.
  Shared header ciphertext lives in the definition document, with AAD bound to
  organization, definition and transport; public definition responses omit it.
  Definition edits and header writes use revision-checked storage updates: a concurrent
  change returns 409 instead of overwriting new settings or recreating a deleted row.
  Decoded shared maps are cached by encrypted revision within each control plane
  (bounded to 256 entries), and compiled into direct/combo/diagnostic/discovery
  snapshots. This adds no database query to the inference forwarding path.
  Definitions without shared headers retain their prior stored JSON shape. Definitions
  with shared headers require updated server processes; older strict readers reject
  the new field rather than silently omitting its behavior. Mixed-version rollout and
  rollback of populated definitions still require deployment acceptance (retain backups).
- `GET /api/admin/providers` lists redacted provider metadata.
- API connections accept optional `protocol`: `auto` (URL detection), `openai`,
  `openai-responses`, `openai-embeddings`, `cohere-rerank`, `anthropic` or `gemini`.
  An explicit format permits a custom inference path; Gemini uses a model-collection
  base URL. HTTPS, credential-free URLs, DNS/address checks and no redirects still
  apply. Queries/fragments are not supported. OAuth connections own their protocol.
  Omitting the field preserves existing configuration; `auto` explicitly resets it.
  Changing it requires the credential again and returns 409 if an enabled combo
  would become incompatible. The saved format applies to direct/combo requests,
  connection diagnostics and model discovery after restarts. Model discovery has
  its own configurable path; a custom inference path does not imply `/models`.
- `PUT /api/admin/providers/{id}` accepts `provider`, `upstream_url`, `api_key`
  and optional `tenant_id`, `enabled` and `rate_limit_scope` (`auto`, `connection`
  or `model`). It also accepts an operator-facing `label`, optional `account_email`,
  optional `expires_at_unix`, and `auth_scheme` (`auto`, `bearer`, `x-api-key` or
  `x-goog-api-key`). The chosen scheme controls the actual upstream request header;
  expired credentials are rejected before network I/O and combo routing skips them.
  New records default to tenant `red`; ownership is immutable after creation and is
  returned as redacted provider metadata. Existing rows without authentication
  metadata keep protocol-derived defaults. `credential_type: "oauth"` imports a Codex or
  Claude CLI token pair when `oauth_provider`, `refresh_token`, a future expiry and Bearer
  authentication are supplied. Both tokens are write-only and encrypted independently;
  only the OAuth provider and string-encoded rotation generation are returned.
- `POST /api/providers/codex-auth/import` and `/import-bulk` preserve the existing dashboard
  JSON contracts for Codex CLI `auth.json` files without a Next.js backend. The importer bounds
  text payloads, validates the expected token shape and expiry, derives a tenant-scoped stable
  connection ID from workspace plus user identity, and requires `overwriteExisting` before
  replacing that account. The response contains only the redacted provider view; access, ID and
  refresh tokens never appear in the response or audit event. Bulk import accepts at most 50
  entries and reports individual failures without aborting successful entries.
- `POST /api/providers/claude-auth/import` and `/import-bulk` preserve the corresponding Claude
  CLI `.credentials.json` dashboard contracts. Rust performs a bounded bootstrap request against
  Anthropic's fixed CLI endpoint with the imported access token, uses the returned account UUID as
  the stable tenant-scoped identity, and keeps bootstrap response fields out of public provider
  state except for the validated account e-mail. When bootstrap cannot identify an account, an
  operator-supplied e-mail is accepted; otherwise the import fails with `identity_unverified`
  unless the caller explicitly opts into overwrite mode. Tokens remain write-only and encrypted.
- `POST /api/providers/{codex|claude}-auth/zip-extract` preserves the dashboard's bulk archive
  contract without Next.js or filesystem extraction. Rust accepts at most 11 MiB compressed,
  processes ZIP work off the async executor, returns at most 50 JSON entries, and caps each entry
  at 256 KiB and the uncompressed JSON total at 10 MiB. Unsafe paths, non-file JSON entries,
  encrypted entries and oversized archives fail closed; credential-bearing responses are marked
  `no-store`.
- `POST /api/admin/providers/{id}/oauth/rotate` replaces an imported access/refresh-token
  pair and expiry. The caller supplies the last observed `expected_generation`; SQLite uses
  `BEGIN IMMEDIATE` plus a generation CAS to update both ciphertexts and expiry atomically,
  so a delayed writer cannot restore an already-consumed refresh token. A stale generation
  returns `409` and no token is changed. `POST /api/admin/providers/{id}/oauth/refresh`
  performs the provider-side exchange in Rust. A durable SQLite lease prevents replicas from
  spending the same rotating refresh token concurrently, and peer replicas fingerprint the
  resulting durable provider snapshot so they publish the new access token without restart.
- `DELETE /api/admin/providers/{id}` disables that provider and activates the
  most recently updated remaining enabled provider.
- `POST /api/admin/providers/{id}/test` accepts an exact native `model` ID and
  performs one bounded protocol-native request with the provider's encrypted credential,
  pinned transport and configured authentication header. The redacted result contains only
  success, a stable failure category, upstream status and end-to-end latency. Provider bodies,
  credentials and transport errors are never returned; the probe is capped at 30 seconds and
  1 MiB, and an expired credential is rejected before network I/O.
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
  combos, client keys, provider health/quota observations and LKGP state only inside its
  bound tenant and can read the shared model catalog; omitted ownership defaults to that
  bound tenant. `issuer` remains limited to the scoped provisioning endpoint. The bootstrap
  administrator remains the recovery identity. New bindings can supply `oidc_issuer` and
  `oidc_subject`; Rust stores a stable opaque identity derived from that pair, so a verified
  e-mail rename does not change ownership and reusing the e-mail with another subject does not
  inherit access. Existing `subject: "oidc:..."` e-mail/sub bindings remain compatibility aliases,
  but canonical pair bindings take precedence when both exist. `DELETE
/api/admin/identity-bindings/{id}` removes a binding durably and immediately revokes bearer and
  browser-session management access backed by it.
- `GET /api/admin/audit-log` and the compatibility route `GET
/api/compliance/audit-log` read Rust-owned audit events with actor, tenant, action, target,
  status and redacted before/after snapshots. Tenant administrators see only their tenant. The
  migrated writers cover tenants, identity bindings, client-key create/update/revoke, provider
  create/update/disable, manual OAuth rotation/refresh, provider health configuration/reset,
  quota create/update/clear, combo create/update/disable and explicit last-known-good pin clearing.
  Provider and OAuth snapshots deliberately omit the upstream URL and all credential/token
  material; background OAuth refresh does not emit an administrative event. MCP, A2A and
  automatic route-learning writers remain follow-up work. Every SQL-backed audit insert also
  appends a versioned `redrouter.audit.v1` envelope to `redrouter_control_audit_outbox` in the
  same transaction. The ordered `(created_at_unix_ms, event_id)` cursor is sink-independent, so
  BigQuery, SQS or other exporters can advance independently. Coupling each business mutation
  itself to that transaction and implementing equivalent RedDB atomicity remain delivery work.
  The first Rust relay targets an existing BigQuery table from the outbox in bounded batches.
  SQL-backed sink leases prevent replicas from draining the same cursor concurrently, failures do
  not advance the cursor, partial `insertAll` failures fail the whole batch, and the stable audit
  event ID is sent as BigQuery's `insertId`.
- Set `RED_ROUTER_AUDIT_BIGQUERY_PROJECT_ID`, `RED_ROUTER_AUDIT_BIGQUERY_DATASET_ID`,
  `RED_ROUTER_AUDIT_BIGQUERY_TABLE_ID` and
  `RED_ROUTER_AUDIT_BIGQUERY_SERVICE_ACCOUNT_JSON` to enable that relay. Optional
  `RED_ROUTER_AUDIT_BIGQUERY_SINK_ID`, `RED_ROUTER_AUDIT_BIGQUERY_BATCH_SIZE` (1-500) and
  `RED_ROUTER_AUDIT_BIGQUERY_INTERVAL_SECONDS` (1-3600) tune its independent cursor. The target
  table currently needs `event_id STRING`, `created_at_unix_ms INT64`, `tenant_id STRING`,
  `topic STRING`, `schema_version INT64` and `payload_json STRING`; automatic table creation and
  dashboard-managed encrypted destination credentials remain follow-up work. The relay currently
  requires SQLite or PostgreSQL because its cross-replica lease must be transactional; configuring
  it with a RedDB backend fails startup instead of silently risking duplicate consumers.
- A second, independent relay exports the Rust usage ledger to BigQuery. Enable it with
  `RED_ROUTER_USAGE_BIGQUERY_PROJECT_ID`, `RED_ROUTER_USAGE_BIGQUERY_DATASET_ID`,
  `RED_ROUTER_USAGE_BIGQUERY_TABLE_ID` and
  `RED_ROUTER_USAGE_BIGQUERY_SERVICE_ACCOUNT_JSON`; the optional `SINK_ID`, `BATCH_SIZE` and
  `INTERVAL_SECONDS` suffixes mirror the audit settings. Enabling it records verified terminal
  usage for every native dashboard key, while quota-enabled keys retain strict reservation and
  admission. Rows contain `event_id`, `created_at_unix_ms`, `tenant_id`, `api_key_id`,
  `api_key_name`, `provider`, `model`, `tokens_input`, `tokens_output`, `tokens_cache_read`,
  `tokens_cache_creation`, `tokens_reasoning`, `tokens_total`, `amount_microusd`, `amount_usd`,
  `pricing_known` and `pricing_snapshot_json`. `api_key_name` is a historical label snapshot;
  plaintext API-key secrets are never persisted or exported. This usage relay currently requires
  SQLite because the Rust-native usage ledger is SQLite-owned.
- The same usage relay can now be managed through the existing usage-sinks dashboard and
  `GET/POST/PATCH/DELETE /api/usage-sinks`. Rust owns the destination row, tenant and optional
  API-key scope, cursor lease and live supervisor. Service-account JSON is accepted write-only,
  encrypted with `STORAGE_ENCRYPTION_KEY`, and returned only as `__stored__`. Updates are adopted
  without restart and revision-bound workers stop before another delivery when a sink is changed,
  disabled or deleted. The dashboard exposes only `instant` mode for these cursor-based
  transports. Signed HTTPS webhooks are also native: every event carries a stable `webhook-id`,
  `webhook-timestamp` and Standard Webhooks-compatible HMAC-SHA256 `webhook-signature`. The
  write-only signing secret is encrypted independently, DNS is resolved and pinned to public
  addresses, redirects are refused, and a cursor advances only after every selected event is
  accepted. Window aggregation, SQS, Kafka, RedDB queue and per-attempt delivery history remain
  legacy-only features.
- `PUT /api/provision/client-keys/{id}` is the tenant-scoped service integration. It
  requires an explicit `tenant_id` and caller-generated `api_key`, so a RedDB Cloud retry
  can safely repeat the same stable key ID and secret without the router retaining plaintext.
  Tenant issuers cannot take over an existing key from another tenant.
- `GET /api/admin/client-keys` lists redacted key metadata and grants.
- The dashboard API-key page detects this Rust authority through `/api/auth/config` and
  talks directly to these admin routes. It preserves the legacy page only when running
  against the Next compatibility server. Rust-managed keys intentionally have no reveal or
  regenerate endpoint: replacement means issuing a new one-time secret and revoking the old key.
- The dashboard provider page uses the same runtime boundary: an active Rust control plane
  lists, creates, atomically replaces and disables provider connections through
  `/api/admin/providers`. Provider credentials are write-only in the browser and the Rust
  response is rejected if it contains plaintext or ciphertext credential fields. Labels,
  account identity, authentication scheme and expiry are edited alongside the connection
  and revision-coupled to the encrypted credential. The page can also import Codex and Claude
  access/refresh-token pairs into the Rust store; it never reads either token back. The full
  Next provider catalogue remains available only in the compatibility runtime.
- The Rust provider page also reads the validated `anomalyco/models.dev` snapshot through
  `/api/admin/model-catalog`, offers its provider namespace while configuring a connection,
  and loads one provider's model metadata only on demand. Global administrators may trigger
  the server-side refresh; browsers never fetch or trust the upstream catalog directly, and
  a refresh failure leaves the last validated bundled or persisted snapshot active.
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
- A client-key policy may include `access_schedule` with `enabled`, exact `HH:MM`
  `from`/`until` values, weekdays `0` (Sunday) through `6` (Saturday), and an IANA
  `tz` such as `America/Sao_Paulo`. Rust validates and persists the schedule, evaluates
  it in the configured timezone during authentication, and denies equal start/end
  windows. Overnight windows are supported. Invalid or revision-mismatched schedule
  state fails closed instead of broadening access.
- `DELETE /api/admin/client-keys/{id}` immediately revokes the key.
- `GET /v1/key` and `/api/v1/key` return only the caller's persisted key identity. The
  dashboard SQLite compatibility reader preserves its configured `flat` or `prefixed`
  model-ID format; Rust-owned keys return their own durable setting.

Native SQLite quotas are enforced entirely by Rust. Every attempt acquires a durable
`BEGIN IMMEDIATE` reservation before dispatch; independent Rust processes sharing the
same file therefore cannot pass the same remaining budget concurrently. Successful
OpenAI-compatible chat, Responses, embedding, Cohere-compatible rerank, native Anthropic and native Gemini responses
atomically append to `redrouter_usage_ledger`, update the weighted token window and release
the reservation. Chat streaming requires `stream_options.include_usage=true`; `[DONE]` is
forwarded only after settlement. Responses streaming settles the typed `response.completed`
event before forwarding it. Native Anthropic streaming combines the usage reported by
`message_start` and `message_delta`, then settles before forwarding `message_stop`. Native
Gemini streaming holds its final usage-bearing response until a clean upstream EOF, settles,
and only then forwards that response. A failed, interrupted, crashed or oversized attempt keeps
its dispatched reservation for explicit reconciliation rather than silently making budget
available; enabling native quotas never silently forwards an unaccounted terminal event.
Money is stored as integer micro-USD. Token prices come from the active exact-ID models.dev
snapshot. Rerank prices use the dashboard override first and then persisted models.dev or
LiteLLM pricing, accepting the legacy `input_cost_per_query` and current
`search_unit_cost` fields. Rust creates the compatible SQLite key/value table when starting
from an empty database, so the same persisted pricing contract works with or without the
legacy application having initialized the file. Spend-governed requests fail closed when the applicable price is
unavailable. Rerank usage is stored as search units, never fabricated token counts; a priced
response without Cohere `meta.billed_units.search_units` also fails closed. Every priced
native ledger row freezes the applicable token-price vector or per-search-unit price,
its source and capture time. Usage reports return that immutable snapshot so later catalog
changes cannot rewrite the explanation of historical spend. Existing priced rows created
before this schema are marked as legacy snapshots with unavailable detail rather than being
silently recomputed.
The operational ledger is SQLite-only for now; configuring native token/spend quotas on
RedDB or PostgreSQL is rejected instead of falling back to process-local counters.
Durable keys' request-per-minute and request-per-day limits use the same SQLite
serialization boundary and conservative weighted rolling-window counters, so independent
Rust processes sharing one file cannot collectively exceed a key's limit. Keys without
request limits do not touch these counters. RedDB/PostgreSQL durable keys and environment-only
policies retain process-local request counters until their shared counter drivers are implemented.
Rust performs an hourly bounded cleanup of expired token/request rolling-window counters.
`POST /api/admin/usage/maintenance` lets a global administrator immediately remove up to
10,000 rows from each counter table and reports whether a later pass may have more work.
This never deletes the financial usage ledger or uncertain reservations, so cost reports
and BigQuery delivery do not lose source events. Tenant administrators cannot trigger
global maintenance.

- `GET /api/admin/usage` reports Rust-owned token and rerank ledger totals, including
  `usage_kind` and `search_units`, pending reservations and the
  newest entries for a bounded time window. Optional `tenant_id`, `key_id`,
  `from_unix_ms`, `to_unix_ms` and `limit` filters support dashboard drill-down without
  exposing credentials. A returned `next_cursor` continues a stable descending export
  while keeping each page bounded. A `tenant-admin` is always constrained to its bound
  tenant; global administrators may inspect all tenants or select one explicitly.
  Responses are non-cacheable and retain integer micro-USD values for exact accounting.
  SQLite indexes cover tenant/key chronological reports and quota/reservation lookups so
  ledger growth does not force an unindexed scan on the inference path.
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
  `cache-optimized`, `context-relay`, `fusion`, `pipeline`, `reset-aware`, `reset-window`,
  `headroom`, `quota-weighted` or `lkgp`),
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
  `fusion` fans out non-streaming, tool-free panel requests to every eligible target,
  starts a bounded grace period after quorum, and sends anonymized panel answers to a
  configured judge target. Its optional `fusion` object persists `judgeModel`,
  `minPanel`, `stragglerGraceMs` and `panelTimeoutMs`. The final judge request reuses
  the normal proxy path, including streaming, translation, fallback, breakers and
  SQLite usage accounting. Tool-bearing requests bypass fan-out and go directly to
  the judge with their tool contract intact. Every physical panel and judge call is
  recorded against the authenticated client quota; slow calls that finish after the
  grace window still complete their health and usage bookkeeping.
  Pipeline executes targets sequentially in dashboard order. Each target may carry
  an optional prompt; the first step receives the original conversation and every
  later step receives only the previous answer as its user turn. Intermediate calls
  are buffered with streaming, tools and stream options removed, while the final call
  re-enters the normal proxy path and preserves the client's streaming and tool
  contract. The optional pipeline object persists maxRetries and retryDelayMs; only
  intermediate 429/502/503/504 responses are retried. Successful physical calls are
  independently recorded in the SQLite usage ledger.
  A target may instead be `{kind: "combo-ref", combo_id: "another-combo"}`. Rust expands
  referenced combos inline in declared order before publishing the immutable route snapshot.
  References must stay within the same tenant and protocol, point to an enabled combo, remain
  within three nesting levels and expand to at most eight unique concrete targets. Cycles,
  duplicate expanded targets and mutations that would strand an enabled parent are rejected
  before persistence. Weighted parents intentionally reject references until weighted nested
  execution has an unambiguous contract.

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
- `POST /api/admin/provider-quotas/{id}/refresh` performs a leased, bounded upstream
  usage refresh for Rust-owned Codex, Claude and Antigravity OAuth sessions. The background poller
  runs the same path every minute, spaces account requests, preserves the last valid
  snapshot on upstream failure and expires stale observations after three minutes.
  Codex retains the verified ChatGPT workspace binding and every provider uses its
  CLI identity headers. Antigravity retains the encrypted project binding, reads live
  per-model and weekly-family RPCs, and conservatively scores the most constrained
  active windows without declaring the whole connection exhausted when another known
  bucket still has capacity. Quota revisions propagate to other SQLite proxy replicas.
- `GET /api/admin/oidc` returns the redacted Rust-owned management authentication
  policy. `PUT` validates, fetches and verifies its JWKS before durably replacing
  the live policy; `DELETE` removes it. The payload contains `enabled`, `issuer`,
  `audience`, `jwks_uri`, `required_claims` and `allowed_subjects`.
  Rust replicas fingerprint the durable policy and confidential browser-client record, so both
  enablement and deletion propagate without restart. A failed reload disables OIDC on that
  replica; the bootstrap administrator remains the recovery path.
- `GET /api/auth/config` is a cache-disabled, non-secret bootstrap for the static
  dashboard. `POST /api/auth/local/login` exchanges the bootstrap administrator key for
  an encrypted 12-hour browser session without persisting the key in browser storage. The
  login requires an exact HTTP(S) Origin and the resulting cookie remains bound to that
  origin, the current administrator-key hash and a double-submit CSRF token.
  `POST /api/admin/oidc/discover` performs authenticated, bounded and
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
The Rust dashboard can be built with `npm ci` and `npm run build:rust-dashboard`.
This produces `.build/rust-dashboard`, a static bundle using Rust-backed provider,
resilience, combo, client-key, identity, OIDC, usage, export and audit views. It uses
Rust's local administrator or OIDC browser session; compatibility-only product views
remain in the legacy dashboard rather than adding a Next.js runtime dependency.
Set `RED_ROUTER_SPA_DIR` to that directory or another prepared static build containing `index.html` and
Rust serves it on the same origin without a Next.js server. Startup fails for an invalid
directory. Browser navigation serves exported `route.html` or `route/index.html` pages
when present and otherwise falls back to the SPA shell. Reserved API namespaces,
hidden paths and missing files with extensions never do. HTML and `sw.js` use `no-store`;
versioned `/_next/static/` chunks use immutable one-year caching. Brotli and gzip sidecar
files are selected when present. The server adds CSP, clickjacking, MIME-sniffing,
referrer, permissions and opener protections. `Dockerfile.rust` packages the bundle
with `red-routerd`, and the default Compose service runs that image without Node.js.
Legacy Next.js deployment shapes require an explicit Compose profile.
For npm/CLI packaging, `npm run build:rust-package` stages the SPA and current native
binary under `rust-runtime/`. `red-router serve` prefers those Rust artifacts; use
`--runtime next` only as a temporary rollback, or `--runtime rust` to require the
native server and fail rather than silently starting Next.js.
For a non-mutating inventory before migrating a legacy Next.js SQLite database, set
`RED_ROUTER_PRODUCT_DB_PATH` to that file and run `red-routerd inspect-legacy-sqlite`.
It reads a single snapshot and reports counts without credentials or row contents. This
is an inspection only; `migration_ready` remains false until data import and policy
equivalence have been verified.
For one coordinated offline pass, stop both servers and set
`RED_ROUTER_PRODUCT_DB_PATH`, `RED_ROUTER_MIGRATION_DEST_PATH`,
`RED_ROUTER_MIGRATION_ROLLBACK_PATH` and `STORAGE_ENCRYPTION_KEY`, then run
`red-routerd migrate-legacy --offline-confirmed`. The rollback path must not exist.
The command creates it before writing, then imports pricing and supported disabled keys,
stages encrypted provider records and archives usage/accounting tables. A failure in any
later slice restores the exact destination copy and retains the rollback file. Success
prints a machine-readable report and also retains that file; provider-specific OAuth
adoption, quota reconciliation, verification and activation remain explicit follow-up
steps and never happen automatically.
To migrate the legacy pricing namespaces into an existing separate Rust SQLite database,
set `RED_ROUTER_PRODUCT_DB_PATH` and `RED_ROUTER_MIGRATION_DEST_PATH` to the respective
files and run `red-routerd import-legacy-pricing`. The source is read-only; inserts are
atomic, reruns skip identical rows, and any conflicting destination value aborts the
entire import without overwriting it. This transfers pricing only, not providers, keys,
policies, usage history or destinations; use an offline migration window for cutover.
For an initial subset of legacy client keys, stop both servers and set the same two
paths, then run `red-routerd import-legacy-keys --offline-confirmed`. This requires
an initialized Rust SQLite destination with empty client-key tables and existing,
enabled tenants. It copies IDs, names, SHA-256 key digests, tenant, expiry and model
ID format in one transaction; plaintext credentials are not copied. All imported
keys start disabled while global policy migration remains incomplete. Their original
active, banned and revoked state is retained in `redrouter_legacy_key_migration`;
the command does not automatically activate them. The legacy database is opened
read-only. Unknown key schemas, model restrictions, per-model quotas, budgets,
groups, model mappings, key tags or usage attributes cause the entire import to fail
closed. Supported key-wide quota limits and reservations are adopted separately.
The server refuses to enable an imported key before that adoption. This command does not migrate
provider credentials, usage history, quotas, their counters, or remaining policies;
do not treat a successful partial key import as a complete cutover. It requires a
quiescent snapshot: changes made to the legacy system afterward are not replicated.
For a single simple API-key provider, with both servers stopped and the same paths
set, run `red-routerd import-legacy-provider --offline-confirmed PROVIDER_ID` with
`STORAGE_ENCRYPTION_KEY` set to the key used by both databases. The credential is
decrypted from the legacy format and re-encrypted for Rust with the provider ID as
authenticated data; the imported connection starts disabled and its former active
state is retained in `redrouter_legacy_provider_migration`. The operation rejects
existing destination records, OAuth, custom endpoints, non-default routing or
quota configuration and other unsupported metadata. It does not migrate session
credentials, provider priorities, health history, combos or policies and is not a
complete cutover.
To preserve full legacy provider records, including OAuth tokens and provider-specific
metadata, without activating accounts, stop both servers and run
`red-routerd stage-legacy-provider-records --offline-confirmed` with the two database
paths and `STORAGE_ENCRYPTION_KEY` set. Each row is encrypted as a single Rust envelope
bound to `legacy-provider-stage:<provider-id>`; no plaintext token is written to the
destination. Staged records do not create a connection, refresh a token, or enable
OAuth. If a source field was already encrypted by the legacy server, the original
legacy encryption key remains necessary for a later conversion. Existing staging is
never overwritten; unsupported SQLite field types and schemas abort the operation.
For a staged Codex OAuth record, `red-routerd adopt-legacy-codex --offline-confirmed
PROVIDER_ID` converts its access token, refresh token and ID-token session metadata
to the native Rust format, preserving the provider ID and tenant. Set
`STORAGE_ENCRYPTION_KEY` and, if the source used a different key,
`RED_ROUTER_LEGACY_STORAGE_ENCRYPTION_KEY`. The command refuses a workspace that
does not match the ID token, an unavailable tenant, conflicts, unsupported routing
or provider-specific settings and unsafe provider status. It does not contact OpenAI or refresh tokens;
the connection remains disabled, and the complete original record remains staged.
For a supported Antigravity session, `red-routerd adopt-legacy-antigravity
--offline-confirmed PROVIDER_ID` uses the same environment variables and converts
the access and refresh tokens plus the project ID and CLI session metadata. It
requires a valid project and expiry, rejects conflicting project values, non-CLI
profiles and unsupported provider settings, and leaves the connection disabled.
It does not make a provider request or verify a live session. Other OAuth providers
and advanced routing settings still require conversion.
To stage legacy usage history, cost ledger, quota counters, reservations and budget
tables without rounding their stored values, stop both servers and run
`red-routerd archive-legacy-usage --offline-confirmed` with the same source and
destination paths. The source is attached read-only; rows and SQLite value types are
checked before the destination transaction commits. Tables and their row counts are
recorded in `redrouter_legacy_archive_manifest`; source tables that do not exist are
marked with a NULL count. Existing archives are never overwritten. These are inert
staging tables: the historical-usage dashboard can read the cost ledger, scoped to
the authenticated tenant; records with unknown tenant are visible only to a global
administrator. Rust quota admission, current usage totals and export destinations do
not yet consume them, and pending reservations are not reconciled automatically.
Keep the original database and do not activate migrated quotas until accounting,
tenant attribution and delivery state have been converted and verified.
For a disabled key imported from that same offline snapshot, run
`red-routerd adopt-legacy-quota-state --offline-confirmed KEY_ID RESERVATION_TOKENS RESERVATION_MICROUSD`
with `RED_ROUTER_MIGRATION_DEST_PATH` set. The two reservation bounds are explicit
upper bounds for each new request; choose them based on the allowed workloads. The
command adopts supported TPM, RPM, daily-token and monthly-spend limits, current-day
input/output tokens, current-month successful spend, current and previous minute
counters and outstanding reservations in one transaction. It leaves the key disabled.
The archived event history is not inserted into the native ledger, avoiding double
counting. Legacy spend, pending spend and fractional counters round upward for quota
enforcement, while a monthly spend limit rounds downward by at most one microdollar;
original values remain in the archive. `reserved` and `dispatched` rows are both
kept as unresolved holds. The command refuses missing archives, unattributed current-period rows,
enabled keys or existing native state. Keep both servers stopped throughout the
archive, key import and adoption window; the archive must be from the same snapshot.
To inspect Rust-owned pending holds, set `RED_ROUTER_NATIVE_DB_PATH` to the native
SQLite file and run `red-routerd list-native-reservations`. After verifying actual
usage, cost, and that the event is not already included in the legacy baseline,
run `red-routerd reconcile-native-usage --verified RESERVATION_ID usage.json`.
The JSON must contain `timestamp_ms`, integer `amount_microusd`, an `evidence`
description, and OpenAI-compatible `usage` with `prompt_tokens` and
`completion_tokens`. Include reasoning/cache details when applicable. The amount
and evidence are operator assertions, not inferred prices; check them against the
provider. Reconciliation atomically writes the ledger and minute counter and
removes the hold. Do not put credentials or sensitive response content in evidence.
For a native (not imported) client key with an existing global usage quota and a
positive token reservation bound, stop all servers, disable the key and set
`RED_ROUTER_NATIVE_DB_PATH`. Run `red-routerd configure-model-token-limit
--offline-confirmed KEY MODEL INTERVAL RESET_MINUTES LIMIT`. Intervals are
`daily`, `weekly` (Monday), or `monthly`; reset minutes are 0–1439 from midnight
UTC. Multiple windows can apply to the same model. The SQLite admission transaction
counts recorded model tokens and outstanding model reservations across processes.
The dashboard cannot yet manage these rules, and legacy model counters and limits
are not yet imported; imported keys are rejected by this command. The existing
global quota and compatible per-request reservation must remain configured.
Provider credentials are encrypted with a random salt and nonce, authenticated against their
provider ID, and never returned by the API. The durable database is updated before an
atomically replaced, DNS-pinned runtime target becomes visible. Invalid storage or
configuration fails closed. Client secrets are reduced to SHA-256 lookup hashes before
storage and are never returned. Supported client policy fields are `enabled`,
`expires_at_unix`, `scopes`, `allowed_endpoints`, `allowed_models`, `blocked_models`,
`allowed_provider_ids`, `max_concurrent_requests`, `max_requests_per_minute` and
`max_requests_per_day`. Combo writes are durable before an immutable, DNS-pinned routing
snapshot becomes visible. Once any combo row exists, Rust-owned combos are authoritative;
unknown or disabled aliases do not fall through to the active provider. Target routing metadata
and provider quota observations are durable. Antigravity model buckets and weekly model-family
windows are persisted as one replaceable snapshot and override the provider aggregate on the
lock-free routing path; an expired or removed model observation falls back to the provider view.
Codex, Claude and Antigravity OAuth quota polling is automatic; provider-specific collectors for
the remaining account types and the remaining dashboard settings still need migration.

The Rust provider dashboard can start browser OAuth for Codex, Claude Code and Antigravity, or
import one to fifty existing JSON sessions (including bounded ZIP extraction). These browser
requests use the same OIDC session, same-origin checks and double-submit CSRF boundary as other
management writes. Browser OAuth reauthentication is bound to the existing deterministic
connection ID so signing in with another account is rejected before persistence. Imported and
exchanged credentials are write-only after the request completes.

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
is held in this process's memory for this environment-only policy format, resets on restart,
and is not shared between multiple proxy instances. Rust-owned durable keys use atomic shared
SQLite counters instead, as described above.

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
