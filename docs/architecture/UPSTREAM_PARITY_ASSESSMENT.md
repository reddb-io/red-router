---
title: "Upstream parity and persistence assessment"
status: in-progress
lastUpdated: 2026-09-26
---

# Upstream parity and persistence assessment

This is a source snapshot, **not a claim of complete feature parity**. The comparison uses
`upstream/master` at `f01fb909e37189008080632ddaf404f096345cde` (9router),
`omni-upstream/release/v3.8.51` at `ae2ba35852d4e5a55486a1c0e6a779105564fd6d`
(OmniRoute), and the local `feat/systemone-parity` worktree based on `cf5d22c291`.
Refresh the refs and rerun `node scripts/ad-hoc/upstream-parity-inventory.mjs` before using
the counts in a later review. The script reads paths and provider IDs; it does not compare
credentials, transport, model lists, billing, UI, or behavior.

## Structural inventory

| Source        | Provider-file IDs | Local equivalent-file candidates missing | `/v1` route files | Local route-file candidates missing |
| ------------- | ----------------: | ---------------------------------------: | ----------------: | ----------------------------------: |
| 9router       |               129 |                                       51 |                21 |                                   0 |
| OmniRoute     |               273 |                                        0 |               100 |                                   0 |
| This worktree |               287 |                                        — |               107 |                                   — |

The 51 9router provider IDs are **not 51 proven missing providers**. For example,
`deepgram`, `elevenlabs`, and `edge-tts` are present in the local audio registry
(`open-sse/config/audioRegistry.ts`), while search, image, video, and embedding
providers have their own registries. Each candidate needs an identity, credentials,
models, wire transport, fallback/quota, exposure, and UI comparison. A matching
name or source file alone is insufficient.

The inventory now annotates those 51 candidates: two match a different local
provider's registry alias (`featherless` and `mmf`), three match an explicit
compatibility alias (`commandcode`, `volcengine-ark`, `xiaomi-tokenplan`), 32
have an exact quoted ID in a specialty registry, and 14 have none of those
structural clues. These are search aids, **not semantic pass/fail totals**.
The scanner now reads the declared provider entry rather than mistaking the
first model's `id` for a provider when model arrays precede the entry. It also
recognizes untyped provider-builder entries such as `seekai`; this corrected
the OmniRoute/local provider-file counts from 272/286 to 273/287.
Even an alias match can hide
model drift: `featherless-ai` had only two old static models, so this worktree
adds 9router's seven current static IDs and the upstream `/v1/models` catalog
URL while retaining the old IDs. Its runtime/model availability remains to be
verified by CI and a real provider connection.

Three of the 14 no-exact-file candidates are **not missing search
transports**. Upstream `linkup`, `searchapi`, and `exa` are web-search providers;
local `linkup-search`, `searchapi-search`, and `exa-search` use the same search
hosts, methods, authentication schemes, limits, and query costs in
`open-sse/config/searchRegistry.ts`. `POST /v1/search` maps all three unsuffixed
IDs to those local entries, and the provider catalog exposes the connections
under the suffixed identities. This is semantic search coverage, not identical
persisted connection identity. The audit found a real Exa gap: upstream also
exposes `POST https://api.exa.ai/contents` as `webFetch`, while the local
`exa-search` card advertised `webFetch` without a dispatch. This worktree now
adds the separate content executor and exposes `exa-search` in the HTTP and MCP
fetch schemas. Only text/markdown is accepted; HTML, links, and screenshots
fail explicitly rather than being fabricated. Tests are written but not run;
CI and real-key smoke still gate operational equivalence.

Four more no-exact-file search candidates are present under suffixed local
identities: upstream `serper`, `tavily`, `youcom`, and `searxng` map to
`serper-search`, `tavily-search`, `youcom-search`, and `searxng-search` in
`open-sse/config/searchRegistry.ts`. Their search hosts, methods, auth headers,
limits, and query costs match the inspected upstream entries. `tavily-search`
also has a separate `/v1/web/fetch` executor. SearXNG remains local-instance
dependent: the catalog's localhost URL is a placeholder, and routing requires
a configured instance. These names are not four additional missing chat
providers; connection identity and live behavior still need verification.

Upstream `xquik` is likewise a search-only provider under local
`xquik-search`. The local wire endpoint and credential scheme match, but the
normalizer silently kept only 20 posts despite the upstream and public search
schema allowing 100. This worktree raises the Xquik catalog/normalizer and
MCP X-search ceilings to 100 while leaving the separate xAI `x-search` limit
at 20. The Xquik
timeout (10 s) and cache TTL (60 s) now match the upstream registry. Billing
previously differed: upstream declares one credit per returned post, while
the local `search_cost_usd` and API-key budget used a flat per-query USD
estimate. This worktree now reports `provider_credits_used` from the upstream
tweet-array length (including malformed rows omitted from normalized results)
and sets Xquik `search_cost_usd` to zero. This avoids booking unverified USD
spend; it does **not** mean Xquik usage is free. A verified USD conversion or a
separate provider-credit budget remains open. Live response shape is also
unverified.

Upstream `ollama` is Ollama **Cloud**, not the local-device `ollama` card.
Local chat already uses the separate `ollama-cloud` identity and hosted API.
The upstream registry also declares `/api/web_fetch`; this worktree adds that
hosted content path to local `/v1/web/fetch`, the provider card, and MCP fetch
input. It requires the existing Ollama Cloud key, accepts text/markdown only,
bounds the response, and fails closed on malformed data. This is a written
integration candidate; CI and live-key smoke have not run. Local Ollama
search and local model execution remain distinct products.

The remaining no-exact-file IDs require different treatment; a syntactic
alias alone would erase product boundaries:

| Upstream ID        | Local evidence                                                                                                                                                     | Assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `azure`            | `azure-openai` has the `azure` catalog alias and a resource-specific executor.                                                                                     | Existing Azure OpenAI product; check deployment/API-version behavior with a real resource.                                                                                                                                                                                                                                                                                                                                                                                         |
| `commandcode`      | `command-code` has compatibility aliases and a dedicated executor.                                                                                                 | Same account product, but local traffic deliberately uses `/provider/v1/chat/completions`; upstream CLI `/alpha/generate` is not a safe substitute.                                                                                                                                                                                                                                                                                                                                |
| `jina-reader`      | Local `jina-reader` catalog and `/v1/web/fetch` executor target `r.jina.ai`.                                                                                       | Structural inventory false negative because this entry lives outside the chat registry.                                                                                                                                                                                                                                                                                                                                                                                            |
| `volcengine-ark`   | `volcengine-ark` and `ark` resolve to `volcengine-coding-plan`; both upstream and local use `/api/coding/v3/chat/completions`.                                     | Account/host boundary matches. Five upstream IDs map to same-version, live-verified local wire IDs. `Doubao-Seed-2.0-Code`, `Doubao-Seed-2.0-pro`, `Doubao-Seed-Code`, and `GLM-5.1` are registered with their exact upstream wire spelling, without version substitution; live Ark smoke is still required for those four.                                                                                                                                                        |
| `xiaomi-tokenplan` | Local `xiaomi-mimo-token-plan` has `tp-` keys, SG/CN/AMS clusters, native Claude/OpenAI transports, and a separate audio registry.                                 | Same subscription product; this worktree adds `xiaomi-tokenplan`/`xmtp` compatibility aliases. CI and regional live smoke remain.                                                                                                                                                                                                                                                                                                                                                  |
| `gitlab`           | Local `gitlab` PAT and `gitlab-duo` OAuth use the public Code Suggestions path `/api/v4/code_suggestions/completions`.                                             | Upstream hidden `gitlab` advertises `/api/v4/chat/completions`, a distinct Duo Chat API. GitLab documents it as internal-only on GitLab.com; on Self-Managed it requires the `access_rest_chat` feature flag and GitLab team-member access. Its request has required `content` (not OpenAI `messages`) and its documented response is a string (not Chat Completions JSON). Do not alias the existing Code Suggestions products to this endpoint or advertise general chat parity. |
| `gemini-cli`       | Upstream marks this provider deprecated; locally it is intentionally retired (410). `gemini` is Google AI Studio API-key transport, not the retired OAuth product. | **Explicit product decision:** do not port or reactivate the Gemini CLI provider; use Antigravity for Cloud Code Assist with a fresh Google sign-in. The legacy ID remains only as a 410 tombstone and migration notice for stored connections. Incoming requests from the Gemini CLI remain compatible as a client protocol, not a provider.                                                                                                                                      |
| `zed`              | Local `zed` is IDE keychain import; `zed-hosted` implements RSA native sign-in and `cloud.zed.dev/completions`.                                                    | Hosted capability exists under a different identity, but the upstream `zed` ID conflicts with an existing local product. Do not alias it blindly.                                                                                                                                                                                                                                                                                                                                  |

The GitLab Chat contract above is from GitLab's [Duo Chat completions API
reference](https://docs.gitlab.com/api/chat/), checked on 2026-09-26. The
9router registry declares the endpoint and OAuth scope, but supplies no
GitLab-specific executor or translation for the documented `content` request
and string response. Its registry entry alone is not evidence of a working
OpenAI-compatible provider. A separate, explicitly internal/self-managed Chat
identity would need its own request/response adapter, entitlement gate, OAuth
and host configuration, plus a credentialed smoke before it can count as parity.

The user explicitly excluded the deprecated `gemini-cli` **upstream provider**
from the parity target: Antigravity is the active Cloud Code Assist path. This
does not remove the inbound Gemini CLI client identity (requests using this
router as their server), nor does it delete legacy connection rows. The retired
ID must keep returning 410 so old credentials cannot silently route through a
different Google OAuth client. Structural inventory still counts the upstream
file; it is an intentional exclusion, not an unimplemented provider to port.

The Alibaba audit found the converse: a similar provider name did not imply
the same key product. `alicode`, `alicode-intl`, `alims-intl`, and `alitp-intl`
now have separate local registry entries matching 9router's distinct Coding
Plan, Model Studio, and OpenAI-compatible Token Plan hosts. The pre-existing
`bailian-coding-plan` Anthropic-format entry remains separate. These new
connections still need CI and real-key authentication smoke before operational
parity can be claimed.

### Provider identity gaps confirmed by transport inspection

| 9router provider    | 9router identity and wire contract                                                                                                                                                 | Local state                                                                                                                                                                                                                                                  | Required port boundary                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `windsurf` (`ws`)   | Firebase sign-in or `sk-ws-*` credential, Codeium `exa.language_server_pb.LanguageServerService/GetChatMessage` over gRPC-web protobuf; separate model-UID map and Windsurf quota. | Separate direct-key registry, model UID catalog, bounded gRPC-web executor, chat-based credential probe, Firebase token callback/exchange, and a candidate API-key quota fetcher are written in this worktree. `devin-desktop` remains a distinct transport. | CI and live browser/real-key smoke; quota response/entitlement verification, tool-call translation, and account-specific catalog remain open. Do **not** alias `windsurf` to `devin-desktop`. |
| `qoder-cn` (`qdcn`) | Qoder China OAuth/PAT, `.com.cn` gateway and OpenAPI hosts, COSY-signed agent-chat SSE, distinct model IDs and quota.                                                              | Local `qoder` uses the global DashScope-compatible or `qodercli` path.                                                                                                                                                                                       | Separate connection identity, China device auth/re-login, COSY transport, model catalog, quota, and tests. Do **not** alias `qdcn` to `qoder`.                                                |

These are confirmed functional gaps, not just missing registry filenames. The
9router Windsurf executor currently skips tool-call chunks and passes some raw
upstream errors into SSE; its code cannot be copied unchanged under this
repository's stream/error-sanitization rules. Porting must preserve tool-call
semantics or explicitly reject unsupported requests, bound protobuf frame and
message sizes, honor aborts, and sanitize error bodies before exposing the
provider. The upstream catalog alone is not proof that every listed model is
available to a given Windsurf account. The new direct-key path remains an
unverified implementation candidate until CI and real-connection smoke pass.

`open-sse/executors/windsurfWire.ts` encodes the observed LanguageServerService
request shape and incrementally parses bounded gRPC-web frames. The executor
rejects tool requests and non-text input before dispatch, and fails on tool-call
chunks rather than silently dropping them. It sanitizes stream errors and does
not return the credential-bearing protobuf as a loggable transformed body.
Connection validation sends one short chat request, which may consume credits;
it cannot be treated as a no-cost auth probe. Quota, full tool semantics, and
live credential/browser verification are still open. The written tests have
not been run locally.

The static model IDs in `open-sse/config/windsurfModels.ts` match the IDs in
`upstream/master:open-sse/providers/registry/windsurf.js` exactly (sorted-set
comparison on 2026-09-26). This does not prove account entitlement: the
registry is a global catalog, not an authenticated per-account model response.

The 9router snapshot's Windsurf OAuth flow uses an implicit browser callback
with `access_token` (Firebase JWT), then exchanges that token through
`RegisterUser`. The local callback now accepts that token for Windsurf only,
checks `state`, binds its callback server to loopback, and masks the public
browser client ID via `resolvePublicCred()`. The Firebase token is not kept in
provider-specific connection data after exchange. The 9router registry
declares a `GetPlanStatus` quota URL, but no Windsurf usage fetcher was found
in that snapshot. Its documented call shape uses `X-Auth-Token` with a session
token, while the local connection retains only the exchanged Codeium API key.
Sending that key to the website quota endpoint, or silently storing the
short-lived Firebase JWT as a substitute, would be an unverified auth change.
This worktree now has a **candidate** API-key quota fetcher against Codeium's
`GetUserStatus` Connect RPC (the same response parser used by Devin CLI), with
Windsurf IDE metadata and the retained Codeium key. It is bounded, returns no
invented balance if the protobuf fields are absent, and never exposes response
text or the credential in an error. The unit contract is written but not run.
The Codeium key's acceptance at this endpoint and Windsurf's actual quota
field layout still require CI plus a credentialed response fixture and live
smoke. Until then, usage support is experimental and must not be counted as
verified upstream parity; the separate website `GetPlanStatus` path remains
unimplemented.

### Qoder CN transport boundary

The `qoder-cn` row is **not** an alias or host override for the local `qoder`
executor. In the inspected 9router snapshot, `qoder-cn` has its own `qdcn`
alias and `qoder.com.cn` login, `openapi.qoder.com.cn` device-token/userinfo,
PAT-exchange/quota, and `gateway.qoder.com.cn` model-list/chat hosts. The
browser flow is a PKCE-challenged **device** login; PATs must first be exchanged
for a `jt-*` token. Chat signs the exact request body with COSY and sends a
server-published `model_config` from `/algo/api/v2/model/list`. The upstream
executor treats a missing model config as a hard error because guessing one can
silently select a different model. Its static model list is only a discovery
hint, not a substitute for the authenticated catalog.

Locally, `open-sse/executors/qoder.ts` dispatches `pt-*` through the installed
`qodercli` binary and other keys through DashScope's OpenAI-compatible API.
`src/lib/oauth/providers/qoder.ts` has an experimental, env-gated browser
authorization-code flow, not the upstream device flow. The local PAT path
explicitly notes that the old pure-HTTP COSY reimplementation no longer works
for its global endpoint. Therefore, copying 9router's COSY signer or pointing
the existing executor at the CN gateway is **not** evidence of a working CN
connection; neither source snapshot supplies live CN credentials or a passing
CN chat smoke in this worktree.

`src/lib/oauth/providers/qoder-cn.ts` now implements the CN device-login
primitive and poll mapping with bounded responses; focused tests are written
but not run. `open-sse/services/qoderCnPat.ts` adds the separate CN PAT-to-job
token exchange, user-ID lookup, and bounded, region-isolated cache. It fails
closed instead of forwarding a raw PAT to COSY after an exchange error.
`open-sse/services/qoderCnCosy.ts` and `qoderCnModels.ts` add a host-restricted
signer and account-scoped live model-list fetcher that retains the exact
`model_config`. `qoderCnEncoding.ts` and `qoderCnRequest.ts` now encode the
provider's `Encode=1` wire body and construct a chat payload from text/tool
messages using that config. `qoderCnAttachments.ts` uploads bounded inline
images through the signed CN endpoint and preserves HTTPS image references;
unsupported documents fail explicitly rather than being silently dropped.
`qoderCnSse.ts` adds a bounded envelope-to-OpenAI SSE adapter that returns an
HTTP error for a bad first frame, emits a structured SSE error after streaming
begins, and coalesces a finish frame with later usage. Its focused tests are
written but have not been run locally. `open-sse/executors/qoder-cn.ts` now
connects the PAT exchange, live config, image upload, payload encoding, COSY
signing, and streaming/non-streaming responses as a separate candidate; it is
registered under `qoder-cn`/`qdcn`, not the global `qoder` executor. Signed
chat and upload bodies are single-use
streams so the shared proxy fetcher does not replay their COSY signatures
after an ambiguous transport failure. Configured-proxy behavior still needs
CI and live validation. `qoderCnQuota.ts` reads the CN quota endpoint after
PAT exchange and does not invent absent balances; the CN-only validator checks
the authenticated model catalog. Both are wired into their existing
dispatchers, with tests written but not run locally. OAuth device login, its
provider catalog entry, and the modal's CN machine-ID forwarding are now wired.
This is an **unverified integration candidate**, not operational parity: native
document handling, CI, and live credential checks remain. Native documents are
an **improvement opportunity**, not a proven 9router feature gap: the inspected
`upstream/master:open-sse/shared/qoder/attachments.js` converts OpenAI file and
Claude document blocks into omission text, and
`upstream/master:open-sse/executors/qoder.js` does the same if blocks survive
rewriting. The local CN path rejects them instead of silently sending a prompt
that suggests the document was available. Neither behavior reads the document
through Qoder's separate file API. Full document support needs that API's
authenticated upload/reference contract and a live fixture; copying the
upstream placeholder would make the request appear successful while dropping
user data.

Before claiming `qoder-cn` operational parity, verify the whole separate product:

1. Verify the wired region-scoped device OAuth and PAT/job-token exchange, with
   `qdcn` resolving only to `qoder-cn`. Never store a raw PAT as a reusable COSY
   token.
2. Verify the wired CN model-list retrieval, exact upstream `model_config`,
   payload builder, body encoder, and signer with bounded chat/SSE handling;
   preserve explicit rejection of unsupported documents until the separate
   file API is implemented, and sanitize every error. Do not fall back to the
   global Qoder or DashScope transports on CN signing/catalog failure.
3. Finish CN quota and credential validation using the CN API, with tests for wrong
   region, expired tokens, model drift, proxying, cancellation, and SSE error
   envelopes. Then run CI plus live device-login, PAT, chat, upload, and quota
   smoke on the CN service before claiming operational parity.

## Route-level comparison against 9router

| Route                   | Current evidence                                                                                                                                                                                                                                                                                                                                           | Parity work required                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/audio/voices`      | A new route lists ElevenLabs, Deepgram, Inworld, and Edge TTS voices. It uses stored cloud credentials, a public Edge client identifier, bounded fetches, and generic upstream errors. `local-device` still returns 501 on public `/v1`; `/api/local/audio/voices` discovers macOS `say` or Windows SAPI voices behind the local-only management boundary. | CI, macOS/Windows host smoke, and cloud credential smoke are pending. Windows synthesis now uses SAPI WAV then ffmpeg MP3; this remains unverified without Windows CI and a real host. |
| `/v1/videos/[id]`       | New GET route polls xAI via a durable local UUID and the exact provider connection used to create the job.                                                                                                                                                                                                                                                 | CI and live xAI smoke are pending; SQLite remains single-writer, not a replica coordinator.                                                                                            |
| `/v1/videos/edits`      | New xAI route accepts JSON and byte-preserving multipart (64 MiB cap), reserves an idempotent job before the billable POST, and never resends ambiguous outcomes.                                                                                                                                                                                          | CI/live edit smoke, provider capability coverage, and billing verification remain.                                                                                                     |
| `/v1/videos/extensions` | JSON `video_id` can reference a local or upstream job ID; a local ID is translated and the originating connection is pinned. Multipart is forwarded byte-for-byte (64 MiB cap), with explicit `x-connection-id` pinning.                                                                                                                                   | Live xAI extension smoke and provider-specific field validation remain; multipart source IDs are not rewritten.                                                                        |

Host TTS uses a separate trust boundary from cloud TTS. The internal voice
route invokes only fixed `say -v ?` or fixed Windows PowerShell SAPI code with
a bounded subprocess; it
requires the server's authenticated loopback-peer stamp and the `/api/local/`
route guard. Direct `local-device` synthesis and speech-combo fallbacks are
now also restricted to that trusted local peer before reaching `say`/`ffmpeg`.
This is a deliberate security difference from 9router's public local-device
voice path. A raw Host header or remote API key must not authorize host code
execution. Tests are written for CI; no local subprocess smoke has run.
The Windows synthesis script reads text, voice, and output path from its child
environment; none are interpolated into PowerShell source or arguments. A
focused Windows contract job is written in `.github/workflows/ci.yml`; it
checks parsing and invocation shape but not a live SAPI/ffmpeg synthesis.

`/v1/responses/compact` and `/v1/models/info` now have local route files in this worktree,
but their tests have been written, not executed. The former shares Responses admission
and guard checks; the latter projects the authenticated `/v1/models` catalog, including
the `systemone` endpoint for JEV. 9router's virtual search/fetch model entries
have now been compared and projected from the local callable registries; live
result shapes and provider-specific behavior remain unverified.
Its projection now points `webFetch` at the implemented `/v1/web/fetch` route
instead of upstream's `/v1/fetch`, and advertises voice discovery only for the
four providers whose public voices route is implemented. The local-device
voices route returns 501 and is not advertised as discoverable.
The catalog now synthesizes `provider/search` and `provider/fetch` entries from
the actual search/fetch registries, gated by active eligible credentials (or an
explicit anonymous tier), provider blocking, model visibility, exposure policy,
and the existing per-key catalog filter. Unconfigured loopback SearXNG is not
advertised. This is discovery parity, not evidence that every upstream result
shape or live credential works; the written tests still need CI.

The path inventory now has **zero missing 9router `/v1` route files**, but that
does not prove behavioral parity. `/v1/videos/generations` preserves the existing
synchronous OmniRoute result by default and opts into durable async xAI jobs with
`Prefer: respond-async`; 9router uses async by default on the same path. That
contract conflict remains open. The new `190_video_jobs.sql` table gives SQLite
durable job reservation and account-bound polling, not multi-replica execution.
Accepted async create responses expose the provider-native `request_id` and a
separate durable `job_id`; GET accepts either ID within the same caller scope.
The first successful response now projects the freshly committed upstream ID
(previously it fell back to the local UUID because it reused the pre-submit
reservation object). A written route test also holds the first billable POST
open and asserts that a concurrent duplicate gets 409 without a second POST.
The current no-key mode still uses one constant owner scope for all anonymous
video callers (`xaiAsyncVideo.ts::owner`). That makes anonymous idempotency keys
share a namespace and is not a sound public multi-tenant isolation contract.
Before exposing async video to untrusted no-key clients, decide whether this
route requires an authenticated API key or uses a separately designed anonymous
capability/identity scheme; do not substitute a spoofable forwarded IP header.

## Decisions / JEV

The worktree has a typed `/v1/systemone` path and decision-model registry separate
from chat, plus an opt-in JEV signal in Auto-Combo selection/fallback ordering.
The direct endpoint now retains native question shapes and top-level extension
fields, while validating the bounded JSON envelope and overriding only the
resolved model; this matches 9router's decision-protocol pass-through boundary.
Successful upstream JSON is capped at 1 MiB before parsing, with a sanitized
502 on oversized or malformed responses.
TypeSafe AI, OpenCode Zen/Free, and OpenRouter are represented in
`open-sse/config/providers/registry/`; see `open-sse/config/systemOneRegistry.ts`,
`open-sse/handlers/systemOneCore.ts`, and `src/sse/services/jevRouting.ts`.
These are implementation candidates pending CI and external credential smoke.
System One must remain advisory when unavailable or inconclusive; it must not
silently approve task completion or compaction.

## Persistence and scale boundary

`docs/ops/SQLITE_RUNTIME.md` explicitly defines the default as one SQLite writer
and forbids attaching multiple replicas to one `storage.sqlite`. The existing
`src/lib/db/repositories/routingConfigRepositories.ts` composes SQLite-only combo
and model-mapping repositories. `docs/architecture/persistence-backend-boundary.md`
is a **proposed** ADR, not an installed PostgreSQL/MySQL backend or HA guarantee.
The reproducible [SQLite coupling inventory](SQLITE_COUPLING_INVENTORY.md)
identifies the concrete lifecycle, migration, routing, cooldown, quota,
affinity, cache, and video-job boundaries that must be proven before replicas.

The OmniRoute snapshot's `docs/architecture/cluster-decisions.md` is a
historical sidecar proposal, not proof of database HA. Its claim of three
default application replicas plus Caddy conflicts with the checked-in
`docker-compose.yml`: application services are profile-selected, share a
single SQLite `./data` mount per selected container, and have no default Caddy
or three-replica declaration. Both the upstream snapshot and this worktree
already include optional Qdrant and Bifrost Compose profiles. Qdrant can share
vector memory and Bifrost can centralize some proxy traffic, but neither
coordinates API keys, provider connections, quotas, migrations, cooldowns,
video jobs, or SQLite writes. Importing those sidecars is not a substitute for
the proposed repository/shared-backend work or for a tested replica topology.

The safe delivery order is:

1. Keep SQLite zero-config and single-writer, measure WAL/checkpoint, backup,
   migration time, and write contention under representative workloads.
2. Prove a bounded async repository contract with SQLite conformance tests for
   transactions, ordering, timestamps, uniqueness, retries, and encryption.
3. Add an opt-in shared durable backend only after migration ownership and
   concurrent-write semantics are tested. Provider connections, API keys, combo
   definitions, and routing policy must be consistent across replicas; caches
   and in-flight SSE streams remain node-local unless explicitly coordinated.
4. Before advertising replicas, test connection-bound work (including video
   jobs), quotas/lockouts, usage idempotency, failover, rolling migrations,
   and validated SQLite-to-external migration/rollback. An external database
   alone does not supply those runtime guarantees.

No local test result or CI result currently proves this worktree's feature parity
or multi-replica safety. Do not publish either claim until the relevant suites,
provider credential smoke, and deployment topology checks pass.
