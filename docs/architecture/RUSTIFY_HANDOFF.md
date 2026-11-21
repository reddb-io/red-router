# Rustify migration handoff

Read this first when you take over the TypeScript to Rust migration of Red Router. It says what the goal is, what is done and verified, what is open and why, how to work in this repository, and what only a maintainer can decide. The detailed ledger is [RUSTIFY_MIGRATION_QUEUE.md](RUSTIFY_MIGRATION_QUEUE.md); the plan and graph sizes are in [RUSTIFY_ROADMAP.md](RUSTIFY_ROADMAP.md) and [RUSTIFY_PARITY_AUDIT.md](RUSTIFY_PARITY_AUDIT.md).

## Goal and definition of done

Finish the migration of the legacy TypeScript backend (baseline `525a71de`) to the Rust daemon `rust/red-routerd` without losing behavior. The React UI stays as it is and the CLI is ported last. Every legacy behavior needs a Rust counterpart: routing, aliases, provider inference, payload rules, OpenAI request normalization, error classification and cooldowns, quotas, accounts and OAuth. Each is covered by ported tests, by a row in the ledger and, where the Rustify index can take it, by a registration in `rust/port/index.toml`. The offline cutover must import a real legacy database without refusing fields.

The maintainer chose the **cutover** criterion as the definition of done for the first goal: the cutover imports a reference legacy database with no refusal. It is met (see below). The full migration is a much larger goal; treat the open work as a new goal with fronts prioritized by the maintainer.

## Where things live

- `rust/red-routerd` is the destination daemon (axum, sqlx, tokio, reqwest). Unit tests sit next to the code; `tests/` holds integration tests and `tests/cases/*.rs` are pulled in with `include!` (run `rustfmt` on them directly before pushing).
- `rust/port` is the Rustify state: `index.toml` (modules registered as ported), `mappings.toml`, `CONVENTIONS.md`, `rustify.patch`. Rustify only accepts a module whose dependencies are already ported, which is why the large import cycle around `accountFallback.ts` (261 files) cannot be registered in small slices.
- `open-sse/`, `src/` and the rest of the TypeScript tree are the legacy behavior oracle. `internal/compatibility` and `AGENTS.md` carry the repository-wide rules.
- `scripts/legacy-oracle` runs legacy functions under Node and regenerates the committed `rust/red-routerd/src/*_oracle.json` files. See its README.

## What is done and verified

Verified means a differential oracle, an integration test or a real-store run, not only a unit test written by the porter.

- **Cutover.** The offline cutover (`migrate-legacy --offline-confirmed`) imports a real legacy database, one that held keys, models, aliases, providers and a long history, with zero refusals and an unchanged source. Everything it does not map natively is archived or staged, never dropped silently: every legacy table and `key_value` namespace is classified in `src/legacy_tables.rs`, and unknown ones refuse.
- **Provider adoption on that store.** An API-key OpenRouter account, a Cloudflare Workers AI account, an OpenCode Go account and a Claude OAuth account adopt. OpenCode Go adopts onto its chat completions endpoint, so only its 32 chat completions models are usable; the other 36 are refused per model. The Claude account adopts disabled and expired, as the legacy store holds it, and needs re-authentication to serve. Two accounts do not adopt (see open work).
- **Native features added for the cutover.** Provider pool target for combos, self-service `/v1/me/status`, the `@@om-usage` command, per-connection model auto-sync with the legacy scheduler timing, the default per-connection proxy toggle, the Cloudflare Workers AI transport, and importers for API keys, models, aliases, settings and payload rules.
- **OpenAI to Responses translation.** Request translation (`responses_request.rs`, 45 legacy outputs) and the Responses stream to Chat chunk translation (`responses_stream.rs` and its helper modules, hundreds of legacy outputs). Not wired to a transport yet.
- **Failure classification.** `classify_provider_failure` was compared with the legacy `checkFallbackError` over 6,930 status, body and provider combinations; the ban, credit and resource-not-found decisions match (840 are pinned in `resilience.rs`). Three gaps were found and fixed (status gating of deactivation and credit signals, the 429 quota gate, the Mistral 401 order) and one list difference (`your credit balance is too low`).
- **Pure legacy pieces ported and pinned, not yet wired into failure handling.** The per-provider error rule catalog (`provider_error_rules.rs`), text quota cooldowns and reset parsing (`quota_text_cooldowns.rs`, `quota_reset_parsing.rs`), the configured error rule table (`error_config.rs`), retry hint parsing and error text classification (`error_text_classification.rs`).

## Open work, in rough order of leverage

1. **Wire the failure-handling pieces.** Blocked on a policy decision (below). The service supervisor cooldown from `error_config.rs` is already wired (a 503 with `X-Omni-Fallback-Hint: connection_cooldown` is a fixed 5 s connection cooldown, no backoff, not counted against the provider breaker); the rest of the pieces are not.
2. **Adopt the remaining accounts of the real store.**
   - *OpenCode Go (partly done).* The account adopts and the 32 chat completions models work: `product_provider.rs` gives it the chat endpoint and `supports_model` refuses the other 36 (the upstream itself rejects them with an explicit "not supported for format" error, so nothing is misrouted silently). What is left is the other 36: a `ProviderProtocol` variant for OpenAI to Responses (about 25 match sites in `lib.rs` and `control_plane.rs`), a protocol chosen per model instead of per provider (`opencode_go.rs` has the table: 16 Messages, 20 Responses), the Messages header and auth rules, and the request transforms of the legacy `OpencodeExecutor` (1,458 lines: effort tiers, Muse Spark minimum output tokens, the Zen `x-api-key` case).
     Update: the control-plane target builder (`ProxyState::control_target`) now routes the 16 Messages models of an `opencode-go` account to `/messages` with `OpenAiToAnthropic` and `x-api-key` (unit test `opencode_go_target_tests`). Still open: an end-to-end test against a mock `/messages` upstream, and `product_provider::supports_model`, which still refuses those models on the product path. The 20 Responses models are untouched.
     Original plan for the Messages models: the daemon already translates a chat request to an Anthropic upstream (`OpenAiToAnthropic`, sent with `x-api-key` and `anthropic-version: 2023-06-01`, which is what the legacy executor sends for the `claude` format). The protocol is derived per account in `control_plane.rs` from `(request_protocol, configured)` where `configured` comes from the account record; for `opencode-go` derive it per model instead (`opencode_go::target_format`) and point the target at `opencode_go::url(model)`, then cover it with an integration test against a mock `/messages` upstream. The 20 Responses models additionally need the OpenAI to Responses protocol (`responses_request.rs` and `responses_stream.rs` are ready but not wired).
   - *Antigravity IDE profile.* Native adoption covers only the CLI profile (`agy`). The IDE profile has its own headers, client version, IDE type enum and project bootstrap.
   - *Codex.* The account has no refresh token in the legacy store, so there is nothing to adopt until it is re-authenticated there. (Claude is done: its adoption now accepts the organization rate limit tier and the token health check bookkeeping, and generates the device id the legacy executor would draw at random.)
3. **Fronts 6 to 15 of the ledger** (organizations and OIDC, analytics, webhooks and exports, images/audio/video/search/files/batches, playground, cache and compression, MCP/A2A/memory/skills/guardrails, agents and bridges, plugins). Each is a large area, not a slice.
4. **Rustify registration.** Recent modules are not in `rust/port/index.toml`. Register the ones whose TypeScript dependencies are complete (for example `errorConfig.ts`, `quotaTextCooldowns.ts`) when the Rustify tool is available.
5. **The CLI** (`bin/cli`) is ported last, by decision.

## Decisions that belong to the maintainer

- **Credit cooldown policy.** The legacy rule table gives a timed cooldown and the account returns on its own (an OpenRouter 402 locks the connection for 2 minutes; Cloudflare's daily allocation text locks until UTC midnight; a bare 402 gets no cooldown at all). The Rust daemon records a terminal `CreditsExhausted` status that only an operator clears. Pick one; the legacy pieces above are ready to wire either way.
- **Closing the first goal** on the cutover criterion, and the priority order of the remaining fronts.

## How to work here

Method: read the TypeScript, port it with tests, format, validate locally, commit, then record it in the ledger (and in the Rustify index when it qualifies). Prefer small vertical slices that change behavior over helpers that would be dead code. Pin a port to the legacy code with an oracle (`scripts/legacy-oracle`).

Local verification (the machine may be weak, so one heavy task at a time):

```bash
cd rust/red-routerd
cargo fmt --check
cargo clippy --all-targets --locked -j 1 -- -D warnings
cargo test --locked -j 1 --lib <module>            # focused unit tests
cargo test --locked -j 1 --test <integration> <filter>
```

On Windows set `CARGO_TARGET_DIR` to a short path: the vendored OpenSSL of `rdkafka` exceeds `MAX_PATH` under a deep worktree path. A full `control_plane` integration run takes tens of minutes; run only the tests you touched and let CI run the rest. The full repository gates are in `AGENTS.md`.

## CI and runners

CI is the `Optional quality` workflow (`quality.yml`), started by `workflow_dispatch`; it does not run on push.

```bash
gh workflow run quality.yml --ref <branch> -f suite=rust
gh workflow run quality.yml --ref <branch> -f suite=workers -f runner_qualification=true
```

- The `RedRouter contracts` (`unit`, `workers`, `all` suites) and `RedRouter UI` (`vitest`, `workers`, `all` suites) jobs run on the **public runner `reddb-public-linux-x64`** when the ref is `main` or `runner_qualification=true` is passed; otherwise they fall back to GitHub-hosted `ubuntu-latest`. Use the `workers` suite with `runner_qualification=true` to exercise the public runner from a branch.
- The `rust` suite (`Rust data plane`, `Rust Windows storage`, the performance and fixture jobs) runs on GitHub-hosted runners (`ubuntu-24.04`, `windows-latest`) by workflow design.
- A new dispatch for the same ref and suite cancels the running one. Wait for a run to finish before dispatching the next, and push only after the previous run passed. The `Rust data plane` job takes about 30 minutes.
- `FastLLM SQLite fixture` is a benchmark job that hung for 55 minutes once and passed on rerun; treat one cancelled benchmark with green test jobs as a flake and rerun.

## Rules that are easy to break

- Never edit `.github/workflows/`. The CI token has no `workflow` scope, so a commit touching it needs a push over SSH by a maintainer.
- No local paths, hostnames, account names, emails or any personal data in the repository, and never a database, key or credential from a real store. Fetch secrets only into a local file you delete afterwards and never print them.
- Importers refuse rather than guess. A refusal is a named error, and a new one needs a test; remove a refusal only by implementing the behavior.
- The legacy data layer opens a real SQLite store when imported under Node. Set `DATA_DIR` before running any legacy module by hand (the oracle runner does).
- Run `cargo fmt --check` before every commit; CI fails on an unformatted test.
- Keep claims in the compatibility inventory narrower than the evidence (`AGENTS.md`).

## Cutover tooling

`red-routerd` subcommands, all offline and requiring the servers to be stopped: `migrate-legacy --offline-confirmed` (environment `RED_ROUTER_PRODUCT_DB_PATH`, `RED_ROUTER_MIGRATION_DEST_PATH`, `RED_ROUTER_MIGRATION_ROLLBACK_PATH`, `STORAGE_ENCRYPTION_KEY`), then per-account adoption: `adopt-legacy-codex|claude|antigravity|xai|openference|github --offline-confirmed <id>` and `import-legacy-provider --offline-confirmed <id>` (they also read `RED_ROUTER_LEGACY_STORAGE_ENCRYPTION_KEY`). `tests/legacy_cutover.rs` and `tests/legacy_providers.rs` hold the fixtures; the staged-record and refusal behavior is documented in `src/legacy_cutover.rs`, `src/legacy_providers.rs` and `src/legacy_tables.rs`.
