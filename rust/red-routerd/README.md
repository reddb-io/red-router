# red-routerd: first Rust data-plane slice

This is an **experimental development slice**, not a replacement for RedRouter. It
implements OpenAI-compatible chat and embeddings, Cohere-compatible rerank, OpenAI Responses, native Anthropic Messages,
and native Gemini GenerateContent routes with a
required client key, separate provider keys, bounded request size and concurrent
streams, reusable HTTP connections, incremental responses, and safe redirect refusal.
It binds only to loopback. The operator can configure OpenAI-compatible HTTPS
providers or literal-loopback HTTP mocks. It does not provide a public listener.

It supports explicitly configured model aliases for OpenAI-compatible, native
Anthropic Messages and Gemini GenerateContent endpoints,
priority or round-robin selection, opt-in fallback, and basic per-key route and
model restrictions. It does not yet implement
RedRouter's full provider selection, quotas, policies, accounting, protocol
full protocol translation, management API, remote listening or inbound TLS.
Its standard database integration persists only the single upstream endpoint;
client and provider keys remain environment configuration. An opt-in mode can
read one OpenRouter or OpenAI API credential from the product SQLite database, as described
below. No product database migration is performed.
It has not been validated as a production gateway. `/healthz` confirms that this
process responds; it is not evidence of provider or database readiness.

## Experimental product SQLite credential

Set `RED_ROUTER_PRODUCT_DB_PATH` to the existing product `storage.sqlite` file,
`RED_ROUTER_PRODUCT_CONNECTION_ID` to the ID of an active OpenRouter or OpenAI API-key
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
Only direct chat requests to the two fixed provider endpoints are supported in
this mode. The requested model must start with the selected product provider,
for example `openrouter/openai/gpt-4o` or `openai/gpt-4o`; the provider prefix
is removed before forwarding. Do not use it as a production replacement.

As an experimental alternative to `RED_ROUTER_PRODUCT_CONNECTION_ID`, set
`RED_ROUTER_PRODUCT_PROVIDER` to `openai` or `openrouter`. Startup then
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
selects fill-first API-key connections for its OpenAI and OpenRouter targets.
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

Tokens, daily and monthly quotas, costs, and other request limits remain
unsupported by Rust and block requests when configured. SQLite is not a
distributed database; do not assume separate node-local files or network-mounted
files share safe cluster coordination. Keep the mode experimental.
For experimental recording of completed non-streaming OpenAI-compatible chat
responses, opt in with `RED_ROUTER_PRODUCT_ACCOUNT_USAGE=1` and product client
keys. Each target must have explicit numeric `input`, `output`, `cached`,
`cache_creation`, and `reasoning` prices in the dashboard's user pricing for
that exact provider and model. Streaming and non-default service tiers are
rejected in this mode. A successful response without valid usage or a failed
SQLite write is returned as an error; the provider may still charge for it.
An interrupted upstream response, failed attempt, process crash, or provider
failure can likewise have unrecorded cost. This mode does not apply token or
spend quotas and is not a reliable billing or enforcement boundary.
The Rust accounting module includes strict OpenAI usage normalization and cost
arithmetic for future integration; it does not yet record usage or enforce caps.

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

| Backend | `RED_ROUTER_DB_BACKEND` | `RED_ROUTER_DATABASE_URL` |
| --- | --- | --- |
| SQLite embedded | `sqlite` | `sqlite:///absolute/path/router.sqlite?mode=rwc` |
| RedDB embedded | `reddb-embedded` | `file:///absolute/path/red-router.rdb` |
| RedDB remote | `reddb-remote` | `reds://user:password@host:5050` |
| PostgreSQL | `postgres` | `postgresql://user:password@host:port/database` |

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
