# red-routerd: first Rust data-plane slice

This is an **experimental development slice**, not a replacement for RedRouter. It
implements OpenAI-compatible chat and native Anthropic Messages routes with a
required client key, separate provider keys, bounded request size and concurrent
streams, reusable HTTP connections, incremental responses, and safe redirect refusal.
It binds only to loopback. The operator can configure OpenAI-compatible HTTPS
providers or literal-loopback HTTP mocks. It does not provide a public listener.

It supports explicitly configured model aliases for OpenAI-compatible and native
Anthropic Messages endpoints,
priority or round-robin selection, opt-in fallback, and basic per-key route and
model restrictions. It does not yet implement
RedRouter's full provider selection, quotas, policies, accounting, protocol
translation, management API, remote listening or inbound TLS.
Its experimental database integration persists only the single upstream endpoint;
client and provider keys remain environment configuration. It does not read or migrate
the existing RedRouter configuration or credentials.
It has not been validated as a production gateway. `/healthz` confirms that this
process responds; it is not evidence of provider or database readiness.

```sh
export RED_ROUTER_LISTEN=127.0.0.1:19091
export RED_ROUTER_UPSTREAM_URL=http://127.0.0.1:19090/v1/chat/completions
export RED_ROUTER_CLIENT_KEY=replace-with-at-least-16-random-bytes
export RED_ROUTER_PROVIDER_KEY=mock-provider-key
cargo run --release --manifest-path rust/red-routerd/Cargo.toml
```

## Experimental database selection

The default is RedDB embedded, using `red-router.rdb` in the working directory.
Override the file with an absolute `file://` URI in `RED_ROUTER_DATABASE_URL`.
Alternatively set `RED_ROUTER_DB_BACKEND` and a matching database URL:

| Backend | `RED_ROUTER_DB_BACKEND` | `RED_ROUTER_DATABASE_URL` |
| --- | --- | --- |
| RedDB embedded | `reddb-embedded` | `file:///absolute/path/red-router.rdb` |
| SQLite embedded | `sqlite` | `sqlite:///absolute/path/router.sqlite?mode=rwc` |
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

On the first run against an empty database, `RED_ROUTER_UPSTREAM_URL` is validated
and saved. On later runs the stored value wins over this initial seed. To change it,
set the environment variables as above and run the binary with `set-upstream`;
restart each proxy process to apply the change. Stop the proxy first when editing an
embedded RedDB file: one RedRouter process can own that file at a time. This slice does not implement
distributed configuration invalidation or database-backed provider credentials.
Build with `--no-default-features` to omit the embedded RedDB engine for a
remote-only or SQLite deployment; choosing `reddb-embedded` in that build fails.

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
billing, or data-handling compatibility. Protocol translation is not implemented.

Native Anthropic Messages can be configured as a separate route:

```sh
export ANTHROPIC_KEY='...'
export RED_ROUTER_ROUTES_JSON='[{"model":"claude-route","protocol":"anthropic","targets":[{"url":"https://api.anthropic.com/v1/messages","model":"your-anthropic-model","api_key_env":"ANTHROPIC_KEY"}]}]'
```

Send native requests to `/v1/messages` with the proxy client key in `x-api-key`
(or an Authorization bearer header). The proxy forwards `anthropic-version`
(default `2023-06-01`) and `anthropic-beta`, and streams the native response.
Each route has one protocol; OpenAI and Anthropic requests cannot be interchanged.
Gemini and other native provider protocols are not yet implemented.

For native OpenAI Responses, configure a distinct route with
`"protocol":"openai-responses"` and a target URL ending in `/v1/responses`.
Send requests to `/v1/responses` with the proxy bearer key and an explicit
`model` matching that route. JSON and server-sent events are relayed without
translation; retrieval, cancellation and other Responses endpoints are not yet
implemented. See the [official streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses).

## Experimental client policies

`RED_ROUTER_CLIENT_POLICIES_JSON` replaces the default client credential with
explicit per-key policies. Each key is read from the named environment variable;
never put a key in the JSON. Without this setting, the original
`RED_ROUTER_CLIENT_KEY` continues to have unrestricted access.

```sh
export AGENT_CLIENT_KEY='replace-with-a-random-client-key'
export RED_ROUTER_CLIENT_POLICIES_JSON='[
  {"api_key_env":"AGENT_CLIENT_KEY","allowed_routes":["my-combo"],
   "blocked_models":["vendor/restricted-model"],"max_concurrent_requests":4}
]'
```

`allowed_routes` restricts the requested model or route alias; omitting it allows
all, while an empty array denies all. `blocked_models` denies matching requested
models and filters matching upstream target model names before selection or
fallback. Rules are exact, `*`, or a namespace prefix ending in `/*`.
`enabled: false` disables a key. Unknown fields, missing keys, duplicate keys,
and malformed rules fail startup. `max_concurrent_requests` optionally limits each
key to 1–64 concurrent requests within this process; a stream holds its slot until
it finishes or is dropped. A busy key receives HTTP 429. Changes apply after restart. These policies are
local to this experimental process and do not import existing dashboard settings,
per-key budgets, quotas, schedules, provider-account restrictions or distributed
rate limits. Do not assume policy parity with the current RedRouter.

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

The next slice needs equivalent routing/authz, accounting, persistence and contract
tests before considering a cluster deployment.
