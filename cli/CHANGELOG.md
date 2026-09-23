# @reddb-io/red-router

## 0.16.0

### Minor Changes

- 60f295f: `/v1/models` entries now carry a `parameters` block with every setting a client must respect (context and output limits, reasoning, accepted thinking levels, whether thinking can be disabled, whether a forced `tool_choice` is accepted, tools, search, input/output modalities). Combos add `members`, with nested combos expanded, and their parameters come from the strictest member. A combo with one member that cannot disable thinking no longer reports that it can. Chat and `/v1/models` responses carry `X-RedRouter-Catalog-Version`, and `/v1/capabilities` advertises it under `catalog`, so clients know when to re-read a cached catalog.
- d7b3f5d: `x-red-router-reasoning: auto` now runs the reasoning autopilot for that request, enforced, even when the autopilot is off or does not cover the key, within the configured floor and ceiling. `x-red-router-hint` gains `effort` (a level the client already chose, applied like the header without a decision call), `stall`, `feedback` (`agrees|corrects|rejects|neutral`) and `frustration` (0..1). The autopilot reads human feedback and frustration from the newest message (Portuguese and English), steps up when the request fills more than half of the serving model's context window, keeps the last level when the decision model does not answer, and changes the level only when a new human message arrives, apart from one step up per human turn when the tool loop stalls or a tool fails. redcode title calls drop to the minimum level. `/v1/capabilities` reports `reasoning.applies`, `floor`, `ceiling`, `min_dwell_turns`, `context_fraction`, `accepts` and `ladder`.

## 0.15.0

### Minor Changes

- ec945d0: Route GPT-6 Sol/Luna and Claude Opus 5.5 at their full effort range:
  
  - **Codex**: advertise Codex 0.155.1 (User-Agent, `version` header and the `/models?client_version=` query), which the backend requires before it serves GPT-6 Sol and Luna. Add `gpt-6-sol` and `gpt-6-luna` (272K context via Codex, 128K output, effort none/low..max) with pricing: Sol $2/$10 (cache read $0.20; >272K $4/$15), Luna $0.10/$0.50 (cache read $0.01; >272K $0.20/$0.75). Astra stays at $10/$50 (>272K $20/$75).
  - **Effort**: GPT-6 keeps `max` on every provider instead of dropping to `xhigh`, and `minimal` (which GPT-6 does not take) rises to `low`. Claude models that take `xhigh` (Opus 4.7+, Opus 5.x, Sonnet 5, Fable 5.x) receive it as-is instead of `high`; a disable request on Opus 5.5 or Fable 5.1 clamps to `low` instead of the invalid `minimal`.
  - **Claude thinking display**: the adaptive thinking block keeps the client's `display`, and models whose thinking cannot be disabled (Opus 5.5, Fable 5.1) get `display: "summarized"` so thinking text is no longer empty.
  - **Claude Code version**: when Anthropic answers `claude_code_version_too_old`, the router adopts the version it names (only upward, process-wide; `RED_ROUTER_CLAUDE_CODE_VERSION` pins it) and resends the request once before any output, with the User-Agent and billing header recomputed.

### Patch Changes

- 2d57a76: `x-red-router-decision: off` no longer drops a client's classification hint: the router's tool routing stays off, but an auto combo still picks its member from an `x-red-router-hint` deliberation sent in the same request, which is what redcode sends once its own System One has chosen the turn's tools. `/v1/capabilities` reports `decision.off_keeps_hinted_model: true`.
- 0a6b919: Skip System One decisions (model, tool and reasoning autopilot) for delegated agent tasks whose content is encrypted, where the decision model would only read ciphertext, and price JEV under its OpenRouter (`typesafe/jev-1.13`) and OpenCode Zen (`jev-1.13-free`) ids so decision rows carry the right cost.

## 0.14.0

### Minor Changes

- 17e2069: Add `GET /v1/capabilities` so clients can detect RedRouter and read its System One availability, combo strategies, decision routing mode, session headers and routing headers; `/v1/models` combo entries now carry their `strategy`.
- 16a4fd5: Accept a client-side classification in the `x-red-router-hint` request header (`complexity`, `deliberation`, `needs_tool`, `tier`). Smart combos take the hinted tier instead of calling the classifier, auto combos take the hinted deliberation instead of asking System One for it, the effort ceiling uses it, and `needs_tool=false` skips the tool decision. Invalid hints are ignored whole; the request detail records what the hint replaced. `/v1/capabilities` now reports `decision.accepts_hint: true`, `decision.hint_header` and `decision.hint_keys`.
- 0bd911b: Read deterministic request signals before asking the decision model: session-title calls go to the cheapest auto-combo member with no decision call, plan mode and stalled tool loops never land on the cheapest member, harness reminders and Codex/Claude Code boilerplate are stripped from the decision state, members that cannot hold the request's context or modality are left out of the question, and `x-red-router-decision: off` now also skips the model decision.
- 1a29822: Successful chat responses now carry `X-RedRouter-Served-Model` (the provider/model that answered, including the combo member) and `X-Request-Id`; non-streaming responses add `X-RedRouter-Cost-USD` when the model is priced, and OpenAI chat, Anthropic Messages and Responses streams add `usage.cost` (USD) to their final usage event. `/v1/capabilities` advertises the header names.
- 6720706: Add per-session combo member stickiness. Requests carrying `x-session-affinity` or `x-parent-session-id` (a subagent is grouped with its parent) are served by the combo member that last served that session, for fallback, round-robin, smart and auto combos, until the member fails or the session is idle for 30 minutes; requests without them keep the combo's own rotation. Both headers are now read as session ids right after `x-session-id`, and OpenAI upstreams receive the session as `prompt_cache_key` when the client did not set one. `/v1/capabilities` reports `session.per_session_stickiness: true`, `session.affinity_headers`, `session.affinity_ttl_ms` and `session.prompt_cache_key: true`.
- d7c6738: Add the reasoning autopilot: per turn it raises or lowers how much the model thinks, from the decision model's deliberation verdict plus request signals (plan mode, stalled or failing tool loops, explicit "think hard", tool continuations, session titles), within a configurable floor and ceiling, with per-session hysteresis to protect prompt caching. Opt in per API key or combo — direct model requests included — in off/shadow/enforce modes; applies on translated routes and the Claude Code passthrough; `x-red-router-reasoning` forces a level or opts out per request, and `X-RedRouter-Reasoning` reports the choice.

### Patch Changes

- 0f71fe8: Advertise Claude Code 2.1.280, the build Claude Opus 5.5 requires, and add Claude Opus 5.5 to the Claude provider with its capabilities (1M context, 128K output, always-on adaptive thinking) and pricing; forced `tool_choice` is downgraded to `auto` on Opus 5.5 and Fable 5.1, which reject it.
- d7f06d7: Keep `tool_choice: "none"` and parallel-tool-call limits across OpenAI↔Claude translation, honor the requested JEV model before a System One provider's default, report usage on Responses `response.completed` so Codex can auto-compact, and stop replaying reasoning fields to Groq, Mistral, and Cerebras.

## 0.13.0

### Minor Changes

- 8db5cc4: Add dynamic RedRouter configuration for Pi, Oh My Pi, Crush, ForgeCode, Smelt, and CodeWhale through one registry-backed settings endpoint.
- de5d1a7: Add the keyed OpenCode Zen PAYG provider with shared fingerprint handling and usage reporting, and map Ollama free-plan monthly quota resets from the signup date.
- f3a7789: Add request-aware usage charts with all-time and provider/model breakdowns, plus scoped Cursor and Claude combo presets and bulk combo operations.

### Patch Changes

- 9947145: Add Text classification provider management, model selection, routing combos, and native JEV examples backed by `/v1/systemone`.
- e64adae: Harden Qoder billing and signed-stream error handling, Cursor AgentService tool and context negotiation, and OpenCode Zen request fingerprinting across streaming and JSON responses.
- d104eeb: Unify System One configuration across the native endpoint, model routing, tool routing, and provider UI; add OpenCode Zen as a JEV gateway; and keep legacy classification routes and combos compatible.

## 0.12.1

### Patch Changes

- 0a958fc: Publish the current named tray and predictable diagnostic-log contract, and keep build-time databases, secrets, and machine identity out of the CLI package.

## 0.12.0

### Minor Changes

- 97723e3: Add direct decision-model routing for combo models and tools, including shadow and enforce modes, model scopes, reasoning ceilings, session-scoped verdicts, and decision observability. Preserve and extend the System One endpoint, expose the router configuration on decision-capable providers, and make Usage the dashboard landing page with Setup under System.

## 0.11.10

### Patch Changes

- 730fffe: Persist private, size-rotated operational logs in platform state directories; expose the current log with `red-router logs --path`, `red-router logs --open`, and the tray's Open log action. Capture server output even without --log and record launcher/tray failures, without recording interactive credential screens.

## 0.11.9

### Patch Changes

- Fix the runtime RedRouter executor to honor the configured remote URL and forward loop-protection headers. Verify catalog discovery and chat forwarding against the built package before publishing.

## 0.11.8

### Patch Changes

- Automatically discover and persist remote RedRouter models, expose them in the local catalog and model picker, and refresh saved catalogs without per-model setup. Keep the last catalog available offline and resync when the remote URL or key changes.

## 0.11.7

### Patch Changes

- c96e27d: Show the RedRouter name beside its icon in desktop system trays.

## 0.11.6

### Patch Changes

- 4eee213: Redesign the Usage and Skills dashboards as compact operational workbenches with clearer navigation, metrics, filters, and accessible controls.

## 0.11.5

### Patch Changes

- 031a4c1: Redesign the Providers dashboard with a denser responsive grid, connection summaries, clearer filters, and refined provider controls.

## 0.11.4

### Patch Changes

- c3a2bd8: Use the canonical RedRouter product name consistently in the dashboard.

## 0.11.3

### Patch Changes

- 4042251: Read the running version from the published CLI package and use the scoped npm package in every dashboard update command.

## 0.11.2

### Patch Changes

- d237284: Keep the sidebar focused on navigation: remove the product-logo treatment, version metadata, and update banner. Move version and update controls into Settings.

## 0.11.1

### Patch Changes

- 12bb452: Use the RedDB mark consistently for the browser favicon, PWA icons, dashboard branding, and system tray.

## 0.11.0

### Minor Changes

- d5aee6f: Add RedRouter as a first-class upstream provider. A restricted machine can connect to a second RedRouter by URL and API key, discover its models, preserve remote account isolation, and reject cyclic router chains. Remove the legacy vendor signature from the sidebar.

## 0.10.0

### Minor Changes

- Harden provider routing and translation across OpenCode, Antigravity, CommandCode, Kiro, Codex, DeepSeek and OpenAI Responses. Add JEV-powered Smart combo routing through the native System One provider cascade, registry-driven OpenCode Go Responses routing, model-scoped thought signatures, strict proxy propagation, safer retry and account cooldown behavior, richer model capabilities and bounded usage overlays.

### Patch Changes

- 216c4ee: Reconnect streaming provider requests up to three times when the upstream connection closes before forwarding its first byte.

## 0.9.1

### Patch Changes

- a275528: Route JEV System One requests through stored OpenRouter credentials using its native Decisions API, with provider fallback and release-smoke coverage.

## 0.9.0

### Minor Changes

- 2625322: Make first-run setup task-first, harden empty-stream recovery, repair capability routing and restore release validation for the app and documentation. Validate JEV releases through a provider cascade instead of requiring the direct TypeSafe API.

## 0.8.1

### Patch Changes

- d0f746e: Expose native System One model discovery through `/v1/models/systemone` and classify System One catalog entries separately from generative chat models for Redcode role setup.

## 0.8.0

### Minor Changes

- 19b2554: Port of the PentatonicDev/9router fork features: external Postgres via Kysely (`DATABASE_URL` → Distributed Mode, schema created on boot, shared database across instances), per-user resource scoping (owner on accounts/keys/combos, admin gating, hidden combos, shared-account admin rules), API key ↔ account bindings (`allowedConnectionIds`) with per-key usage and rename/tags, per-user token-saver flags, canonical error contract with `503 no_active_credentials`, translator credential redaction, boot-time token refresh, quota reset-aware locking, openrouter claude-format routing and credit quota, plus a batch of translator/kiro/thinking/RTK fixes.

## 0.7.2

### Patch Changes

- 869ceaf: The OS tray icon now uses the RedDB design system mark (red chamfered square with the R glyph, rendered from the vendored favicon) at 256px with a 6-size Windows .ico — replacing the leftover pre-rebrand 9router logo shown next to the system icons.

## 0.7.1

### Patch Changes

- 8e3fb0b: Dashboard: remove the leftover 9English/9Remote sidebar entries and promo modal. The displayed version now reads the running server via /api/version (runtime truth) instead of a build-time constant, and the update checker queries the correct npm package (@reddb-io/red-router) instead of the pre-rebrand name.

## 0.7.0

### Minor Changes

- 7464ebd: Data dir moves to `~/.red/router` with the database at `~/.red/router/data.sqlite` (matching the `.red/*` ecosystem layout). One-time migration chain imports existing data from `~/.red-router` (previous layout, including the old `db/data.sqlite`) and from the official 9router origin (`~/.9router`, whose `db.json` is imported into SQLite). `DATA_DIR` env override still wins.

## 0.6.0

### Minor Changes

- 069bbd4: Headless background service + docs: `red-router service install|status|uninstall` runs the gateway under systemd --user (Linux) or launchd (macOS), surviving reboots and crashes. Services bind 127.0.0.1 by default; `--expose` (or `-H 0.0.0.0`) opens the gateway to the subnet. READMEs now teach the `npx -y @reddb-io/red-router@latest` flow.

## 0.5.2

### Patch Changes

- aed0607: Fix CLI app failing to boot from the npm package with MODULE_NOT_FOUND react/react-dom (follow-up to the @swc/helpers/@next/env fix). The standalone bundle now ships react and react-dom too, and the release boot smoke test now packs the real tarball and boots it from an isolated directory so it can no longer pass by resolving dependencies from the workspace.

## 0.5.1

### Patch Changes

- 30545ee: Fix CLI app failing to boot from the npm package (MODULE_NOT_FOUND @swc/helpers / @next/env). Next.js standalone output under pnpm misses runtime-only deps that npm traces in; the CLI build now copies them into the bundle and a boot smoke test gates every publish.

## 0.5.0

### Minor Changes

- ef0d26a: Port upstream data-safety and stream/translator robustness fixes:
  
  - **Database safety**: fail closed before any schema mutation on a corrupted SQLite database; prevent silent database wipe with startup quick_check
  - **OAuth**: parse numeric epoch expiresAt so imported connections still refresh
  - **Streams**: terminate streams that end without a finish_reason; Ollama NDJSON no longer blocked as non-SSE (VS Code chat streaming fixed); commandcode retries transient stream errors instead of emitting fake stop chunks
  - **Translator**: deduplicate/repair repeated tool call arguments; recover tool results that arrive without a call id; keep Responses tool-output images as images; stop emitting literal think tags on Claude→OpenAI; preserve optional tool parameters and function-tool strict across Responses/Codex; repair trailing assistant prefill instead of dropping it; placeholder for binary tool_result blobs; emit max_completion_tokens for gpt-5/o-series; strip output_config.format for Claude-compatible gateways; decloak tool names on claude→claude and same-format OAuth streams
  - **Claude**: drop the diagnostics body field rejected by Anthropic

## 0.4.0

### Minor Changes

- 1ff56e4: Port upstream fixes and features:
  
  - **Combos**: merge member capabilities into combo `/v1/models` entries — boolean features are unioned, numeric limits minimized, nested combos flattened; thinking levels for suffixed ids resolve through the clean model
  - **Capabilities**: OpenAI reasoning models cannot disable thinking (levels drop "none"); o-series globs no longer capture Cline's Solar Pro 4
  - **Translator**: repair tool_call_id lost by Responses clients; preserve function-tool strict across Claude/Chat routes
  - **Catalog**: register the renamed deepseek-flash id; pricing gains missing long-context tiers
  - **Dashboard**: surface why a provider connection test failed

## 0.3.0

### Minor Changes

- 68ff9aa: **Breaking**: the default port changed from `20128` (source dev: `20127`) to **`25050`**. Update clients/tools pointing at the old port, or pass `--port`/`PORT` explicitly.

## 0.2.0

### Minor Changes

- 61edd85: Expose `thinking_levels` per model and LLM combo in `/v1/models` and `/v1/models/info` (intersection across members for combos), and accept thinking-suffix overrides on combo names: `my-combo(high)` applies the level to every routed member, clamped to each member's supported levels.
