# FastLLM as a Red Router data plane: isolated evaluation

This is an evaluation, not a switch of the product proxy. The existing Red
Router dashboard and its SQLite database remain the control-plane baseline.
The test adapter under `scripts/ci/fastllm-poc.mjs` only opens a newly created
synthetic SQLite database with synthetic credentials; it does not read a real
dashboard database and is not an implementation of the production adapter.

## Reproducible inputs

- Red Router: the commit that contains this document and CI workflow; baseline
  product inheritance is tracked in `config/upstream/product-inheritance.json`.
- [FastLLM Proxy](https://github.com/azrtydxb/Fastllm-proxy), Apache-2.0,
  pinned to `07faa4a5068928da49eed5ffbd369d18f8a8243e` (2026-11-06).
- Capability sources, not feature-parity claims: [9router](https://github.com/decolua/9router)
  `1fe586bb1cf35e1ed0cb2150a8ef7d1db040b21d`,
  [OmniRoute](https://github.com/cheaper-inference/OmniRoute)
  `6d5f11878ae1610616724edc195d8bb80f767757`, and
  [LiteLLM](https://github.com/BerriAI/litellm)
  `3f38730d2c3059964a2232856e5fa5e688f58a59`.

## What the CI experiment measures

The `FastLLM SQLite fixture and concurrent agents` job builds the pinned
FastLLM with default features and runs only its proxy role, without starting its
PostgreSQL control plane. At this pinned commit, building with
`--no-default-features` fails because `src/main.rs` refers to the gated
`control` module; see CI run `42301297123`. The job also builds the current
experimental Red Router Rust proxy. A Node process plays both a deterministic
OpenAI-compatible provider and a **test-only** HTTP snapshot/usage adapter. The
adapter reads one client-key hash and one provider credential from a temporary
SQLite fixture built from Red Router migrations. It obtains the one-target
priority combo by invoking `red-routerd fastllm-route-plan`, the first Rust
bridge to the actual product combo reader. The fixture is built from migrations
001, 005 and 211 and the relevant API-key fallback columns. This is not a full
product migration or a dashboard integration. It publishes FastLLM's snapshot format and records received events only
into that fixture. It never reads the real dashboard or its credential store.

`fastllm-route-plan <combo-name>` uses `RED_ROUTER_PRODUCT_DB_PATH` and opens the
product database read-only. It emits route metadata only, without credentials or
an authorization decision. It rejects multi-target combos, other strategies and
unsupported combo fields rather than mapping them to a FastLLM backend pool
whose balancing and fallback semantics can differ. This command does not launch
the proxy, enforce key policies or guarantee live revocation; it must not be used
as a production snapshot service. The POC's synthetic HTTP adapter is not that
service either: FastLLM can retain a previous snapshot when its source fails.

The same mock provider is called directly, through FastLLM, through the
current Rust proxy with its environment-configured key and upstream, and
through the opt-in dashboard-key/SQLite guard forwarding to FastLLM. For each
case, 128 streaming responses run at concurrency 1, 8, 32 and 64, with the
client sending about 35 KB of synthetic context, the provider delaying its first
chunk by 15 ms and its final chunk by another 10 ms. The provider's reported
token counts are deliberately synthetic and must not be used as pricing data.
The CI log records response time to first chunk, total duration, throughput,
maximum observed upstream concurrency, and Linux process RSS. RSS covers each
gateway process only: the Node fixture, SQLite control adapter, dashboard,
client and provider are excluded. The bridge's RSS covers its Red Router
process only and excludes the separate FastLLM process, so it is not the total
memory footprint of the two-process configuration. The baseline Rust proxy does not have the
dashboard-policy or quota path enabled; it is not an apples-to-apples product
configuration comparison. These are short samples on a shared CI runner, not a
production or cross-machine performance claim.

The test checks unknown-key rejection, simultaneous FastLLM forwards on a
single key, a SQLite fixture update reflected in the engine's snapshot, and at
least one usage batch received by the fixture adapter. It also reports simple
Responses and streaming Anthropic Messages probes; a reported HTTP status is
not full protocol compatibility. It does not prove durable
or exactly-once accounting, actual quota enforcement under concurrent or
multi-instance load, a complete dashboard, Windows support, the 9router or
OmniRoute authentication flows, or a real provider response.

## Customization and compatibility work before adoption

| Existing contract | Work required for a real Red Router integration |
| --- | --- |
| Dashboard and SQLite | Read actual schema/migrations and encrypted provider credentials; produce versioned snapshots atomically; invalidate and revoke keys safely. Do not copy the fixture adapter as a production security boundary. |
| 9router provider auth | Compare provider identity, OAuth acquisition/refresh and per-account restrictions against `src/lib/oauth/providers/` and `open-sse/config/providerRegistry.ts`; a named provider alone does not prove compatibility. |
| OmniRoute routing | Map dashboard combos, per-key allowed models/connections, ordering, fallback, cooldown and other strategies to FastLLM's route model; prove semantics with the existing Red Router contract tests. |
| LiteLLM protocols | Compare chat, Responses, Anthropic Messages and other endpoints, tool calls, reasoning, errors, cancellation and SSE across providers. Keep LiteLLM MIT and separate enterprise-license boundaries. |
| Quotas and usage | FastLLM documents asynchronous reporting and possible drops/retries and eventual reconciliation across replicas. Implement or integrate durable, idempotent accounting and concurrent limits consistent with Red Router; do not treat the fixture's `/usage` receiver as a billing implementation. |
| Secrets and snapshots | FastLLM's snapshot contains usable upstream credentials and its HTTP mode can persist a last-known-good snapshot on disk. Define encryption, transport authentication, filesystem permissions, revocation and failure behavior before connecting real secrets. |
| Cluster | SQLite remains local authority for this evaluation. Multi-node coordination needs an explicitly designed shared authority; neither a copied SQLite file nor the fixture provides it. |

The original 9router, OmniRoute and LiteLLM are upstream capability sources;
this experiment does not replace them or establish complete inheritance.
