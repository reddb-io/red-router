# red-routerd: first Rust data-plane slice

This is an **experimental development slice**, not a replacement for RedRouter. It
implements one OpenAI-compatible chat route with a required client
bearer key, a separate provider bearer key, bounded request size and concurrent
streams, reusable HTTP connections, incremental responses, and safe redirect refusal.
It binds only to loopback. The operator can configure one OpenAI-compatible HTTPS
provider or a literal-loopback HTTP mock. It does not provide a public listener.

It does not yet implement RedRouter's provider selection, database, quotas, retries,
policy, accounting, model translation, management API, remote listening or inbound TLS.
It has not been validated as a production gateway. `/healthz` confirms that this
process responds; it is not evidence of provider or database readiness.

```sh
export RED_ROUTER_LISTEN=127.0.0.1:19091
export RED_ROUTER_UPSTREAM_URL=http://127.0.0.1:19090/v1/chat/completions
export RED_ROUTER_CLIENT_KEY=replace-with-at-least-16-random-bytes
export RED_ROUTER_PROVIDER_KEY=mock-provider-key
cargo run --release --manifest-path rust/red-routerd/Cargo.toml
```

For an OpenAI-compatible provider, set `RED_ROUTER_UPSTREAM_URL` to its complete
HTTPS chat-completions URL, `RED_ROUTER_PROVIDER_KEY` to its credential, and
`RED_ROUTER_CLIENT_KEY` to a different strong random key. Do not commit or log keys.
DNS answers are checked and pinned at startup; restart to pick up DNS changes.
Private HTTPS targets require `RED_ROUTER_ALLOW_PRIVATE_UPSTREAM=1`. Cloud metadata
and link-local addresses remain blocked. HTTP is allowed only for literal loopback.
Redirects are refused. System proxy environment settings are deliberately ignored.

The next slice needs equivalent routing/authz, accounting, persistence and contract
tests before considering a cluster deployment.
