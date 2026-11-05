# red-routerd: first Rust data-plane slice

This is an **experimental development slice**, not a replacement for RedRouter. It
implements one OpenAI-compatible chat route with a required client
bearer key, a separate provider bearer key, bounded request size and concurrent
streams, reusable HTTP connections, incremental responses, and safe redirect refusal.
It binds only to loopback. The operator can configure one OpenAI-compatible HTTPS
provider or a literal-loopback HTTP mock. It does not provide a public listener.

It does not yet implement RedRouter's provider selection, quotas, retries, policy,
accounting, model translation, management API, remote listening or inbound TLS.
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
