# @reddb-io/red-router

## 0.22.0

### Minor Changes

- 328d62d: Claude Code now works through RedRouter like a direct connection to Anthropic.
  
  **What changes for the user.** When Claude Code talks to an Anthropic first-party account (`claude`, `anthropic`, or an Anthropic-compatible node pointed at api.anthropic.com):
  - auto mode's safety checks run server-side, so classifier requests are no longer billed;
  - Claude Code shows the plan's usage limits;
  - retries follow Anthropic's own signals;
  - preserved thinking and prompt-cache attribution keep working.
  
  This is the passthrough Anthropic's gateway protocol asks for. RedRouter now does the following, on that path only:
  
  - **Request body.** It is forwarded unchanged, including fields RedRouter does not know, such as `safeguards`. None of these run any more:
    - message normalization;
    - tool deduplication;
    - the structured-output, `temperature` and `diagnostics` strips;
    - cache-breakpoint rewriting;
    - token savers. A request can still opt in with `x-red-router-token-saver: on`.
  - **Headers sent to Anthropic.** The client's `anthropic-beta` and `anthropic-version` go through as sent, plus only the flags an OAuth account requires.
  - **Answers.** Streams and JSON answers come back as Anthropic sent them, keeping keys such as `safeguard_results`. RedRouter no longer adds a `[DONE]`, a cost field or a usage buffer.
  - **Response headers.** `anthropic-ratelimit-unified-*`, `x-should-retry`, `retry-after` and `request-id` are forwarded.
  - **Errors.** They keep Anthropic's status, body and headers. Account and combo fallback still work.
  - **Local answers.** Title, warmup and prefill requests are no longer answered locally.
  - **Token counts.** `/v1/messages/count_tokens` returns Anthropic's exact count for these models when the API key is valid, and the estimate otherwise.
  
  Other clients and providers keep their current behavior.

## 0.21.1

### Patch Changes

- 32fa7ac: Dashboard fixes.
  
  - **Request details.** The request-details view no longer crashes when a response's content or thinking is an array of blocks.
  - **Account order.** Reordering the accounts of a provider now saves the whole order at once, with priorities starting at 1. Before, it wrote two 0-based priorities in parallel, so whichever landed last won. With the owner filter active, it also moved the wrong rows. Accounts the user cannot see keep their place, and shared accounts stay admin-managed.
- 46ff592: Gemini, Gemini CLI, Vertex and Antigravity fixes.
  
  - **Reused tool-call ids.** A client that reuses a tool-call id across turns no longer breaks the request. Each result is paired with its own call, and a repeated id is sent to Gemini as `<id>#<n>`. Before, every earlier turn got the last turn's result and name, and Gemini rejected the request.
  - **`errorMessage` in tool schemas.** It is now removed from tool schemas, where Gemini rejected it with "Unknown name errorMessage".
  - **Parameters named like schema keywords.** Tool parameters named `title`, `format`, `default` or `errorMessage` are no longer deleted as if they were schema keywords.
- 6fe1efa: Provider fixes.
  
  - **Kiro IDC.** IDC accounts find their profile again, in their own AWS region. The old lookup used a retired endpoint pinned to us-east-1, which failed with "profileArn is required".
  - **Proxy relay.** Relay and DNS-bypass requests no longer drop request headers (auth, content type) when they arrive as a `Headers` object.
  - **DNS bypass.** The bypass for MITM-intercepted hosts runs only when the system DNS actually redirects the host to a local address. The Google DNS lookup has a 2 s timeout, the bypass connection a 10 s connect timeout, and any failure falls back to a normal fetch. This fixes hangs on networks that block 8.8.8.8 or use split-horizon DNS.
  - **Cline.** Cline and ClinePass now always stream, and the older `{data:{choices}}` reply shape is unwrapped.
  - **Xiaomi MiMo.**
    - The retired `mimo-x-*-preview` models are replaced by `mimo-v2.6-pro`, `mimo-v2.6-flash` and `mimo-v2.6-pro-ultraspeed`, served through the account route.
    - The old preview ids still work: they map to their v2.6 successors.
- d0bafc1: Security and routing fixes.
  
  - **`/v1/systemone` now enforces the API key's rules.** It applies the key's request/token/spend limits (429 with Retry-After) and its model allow/deny rules (403); before, any valid key could bypass both. The router's own smart-combo classifier call is exempt, since its chat request already passed them.
  - **Usage statistics no longer expose API keys.** The 7-day, 30-day and "all" views sent the full key inside `/api/usage/stats`, `/history` and `/stream`. Rows are now identified by the key's id (or a hash). Two keys whose masked forms match are no longer merged into one row.
  - **A combo tries its next member when the model itself is the problem.** Status 410, 406, or a 400/404/422 saying the model is not found, not supported, retired or not served on this endpoint, no longer end the combo. A request error that every member would repeat, such as a context overflow or a bad parameter, still ends it.
  - **Account cooldowns escalate as intended.** A streak of 429s now backs off further each time; before, every 429 locked the account for the same 2 s. A single 5xx right after a success locks the model for 5 s instead of 30 s, and repeated 5xx still get the full cooldown.
  - **Auto combos no longer ask JEV about unusable members.** A member whose accounts are all locked, missing, or outside the calling key is left out of the decision, and stays at the back as a fallback.
  - **Subscription accounts count as free in the auto-combo cost ranking.** A member served by a subscription account (OAuth, web cookie, free) costs 0 there.

## 0.21.0

### Minor Changes

- 4f8c006: In `/v1/models`, a combo's `parameters` now follow its routing strategy.
  
  - **`fallback` combos** state their lead member's parameters. The lead is who serves unless it fails, so its context window, output limit and thinking settings are the ones to plan for.
  - **Other strategies** (`round-robin`, `smart`, `auto`, `fusion`) may land on any member, so they keep the strictest member's parameters.
  - **New fields:**
    - `parameters_basis` (`"lead"` or `"strictest"`) says which basis applies.
    - `parameters_strict` keeps the strictest parameters next to the lead's.
    - `member_parameters: [{ id, parameters }]` gives every member its own parameters.
  - **When another member serves:** `X-RedRouter-Served-Model` names it. A client can switch to that member's entry in `member_parameters` without fetching the catalog again.
  - **Unchanged:** `members` and the top-level `context_length`, `max_completion_tokens` and `capabilities` still describe the safe floor.

### Patch Changes

- 0739c78: OpenAI API conformance. Every `/v1` answer now matches OpenAI's own OpenAPI schemas, which are now checked in CI.
  
  - **`/v1/models`:** entries carry the required `created`, a combo's creation time and a fixed value for everything else, so the catalog version stays stable.
  - **Error bodies:** every `/v1` error has `param` and `code`.
  - **Chat Completions answers translated from Claude, Gemini and other upstreams:** the JSON answer now has `logprobs`, `refusal`, and `content: null` on a tool-call message, and the stream now ends with `data: [DONE]`. Clients that wait for that sentinel no longer hang until the connection closes.
  - **Responses API JSON answers:** they now echo the request settings OpenAI requires (`instructions`, `tools`, `tool_choice`, `parallel_tool_calls`, `temperature`, `top_p`, `metadata`), set `error` and `incomplete_details`, give every output item an `id` and `status`, and include the usage detail blocks.

## 0.20.0

### Minor Changes

- 2e626ee: Account selection now uses measured health and reported quota.
  
  - **Health tracking.** RedRouter measures each account and model: time to first token, latency and error rate, with a circuit breaker that opens after 3 straight failures. The provider page shows each account's TTFT and error rate.
  - **"Prefer healthy accounts"** (Settings, the `health` fallback strategy). The account that answers fastest and fails least leads; accounts not yet measured are tried first, and a few requests explore the others.
  - **Combos.** Combos move a member to the back while its provider is failing on every account, unless the request's own routing chose it.
  - **"Quota-aware routing"** (opt-in). It reads each account's quota every 5 min from the provider's usage API, skips accounts that ran out, keeps a configurable reserve, and uses first the quota that resets soonest. Reports older than 30 min count as unknown, and when every account is exhausted the upstream has the last word.
- beb2b7e: Routing decisions no longer stall when JEV is unavailable.
  
  - **Local score fallback.** A deterministic local score (built from explicit "think" requests, plan mode, stalls, tool errors, feedback, hard or trivial wording, ask length and context size) stands in whenever JEV times out, errors, or has its breaker open:
    - **smart combos** pick a tier from it;
    - **auto combos** send a clearly hard turn to their priciest member and a clearly easy one to the cheapest;
    - **the reasoning autopilot** uses it on a session's first turn.
  - **New smart-combo modes.** `smartMode: "hybrid"` asks JEV only when the local score sits near a tier edge. `"heuristic_first"` asks JEV only when no signal fired.
  - **Total-cost tie-break.** Auto-combo ties are broken by what the whole request would cost (prompt plus expected answer, with the warm-cache discount), not by input price alone.
  - **Cache affinity.** Moving away from the member whose prompt cache is warm needs a clearer verdict (`cacheSwitchStrength`, 0.75 by default).
  - **New Token Saver option: "Drop irrelevant tool output"** (opt-in). JEV judges which older tool outputs the current request still needs, and replaces the rest with a one-line note. Each output is judged once; errors and the two latest outputs are always kept.
- 2fd73ac: - **Client beta flags are kept.** The client's `anthropic-beta` flags now reach Anthropic, merged with RedRouter's own. Before, they were replaced, so a Claude Code `[1m]` model silently lost its 1M context flag. The Claude Code identity flag is still stripped for third-party gateways.
  - **Capability overrides.** You can correct a model's capabilities (images, PDFs, tools, reasoning, whether thinking can be turned off, forced tool choice, web search, context window, max output) from the new "Capabilities" button on each model of a provider page. An override wins over every built-in table and the synced catalog, and applies to routing, `/v1/models` and `parameters`.
  - **Cost-class fallback policy.** A new setting, "Combo Fallback Across Plans and API Keys", decides whether a combo led by a subscription account may fall back to a pay-per-token API key. `no-metered` never falls back to one; `same-class` stays in the lead's class both ways. It can also be set per combo (`costClassFallback`). The default, `allow`, keeps today's behavior.

### Patch Changes

- 079c2d8: `X-RedRouter-Catalog-Version` now changes as soon as a combo is created, edited or deleted, a model is disabled or re-enabled, or an API key's rules change. Before, it could stay stale for up to 15 s, so clients watching it kept an outdated model list. Releases now also run an end-to-end routing check against fixture upstreams (`cli/scripts/e2e-routing.mjs`).

## 0.19.0

### Minor Changes

- a948b59: Give models your own prefixes and names. Each connection of a built-in provider has a "Model prefix" field (Edit connection): `codex-work/<model>` and `codex-home/<model>` then route to their own Codex account only, with no fallback to the other one, while `codex/<model>` keeps using every account. A prefix is lowercase (`[a-z0-9][a-z0-9._-]*`, at most 64 characters) and may not be a built-in provider token, another provider's connection prefix, a custom node prefix or a combo name; connections of the same provider may share one to form a pool. A prefix set on a built-in connection used to be listed by `/v1/models` without routing; it now routes.
  
  `/v1/models` lists a provider's models once per connection prefix, and under the default prefix only while some account has none. An entry under a prefix one account carries names it in `provider.connection: { id, name }`; `aliases` hold the slug and legacy forms only when they reach the same accounts. `catalog.prefixStyle` still applies to default prefixes, and `/v1/catalog` groups each prefix separately (`provider.model_prefix`, `provider.connection`).
  
  User model aliases are listed as models of their own: `{ id: "<alias>", owned_by: "alias", name, alias_of: "<target id>", provider, capabilities, context_length, max_completion_tokens, thinking_levels, parameters }`, taken from the target, and `GET /v1/models/<alias>` returns that entry. An alias is listed only while its target is in the caller's catalog, and a combo of the same name takes precedence. Aliases also resolve through custom node and connection prefixes. `/v1/catalog` returns them under `aliases`.
  
  The provider page gains a "Name & alias" action on each model: a display name that `/v1/models` shows instead of the catalog name, and an alias with its own display name that can route through a connection prefix. `GET /v1/capabilities` advertises `catalog.custom_prefixes` and `catalog.model_aliases_listed`.
- 7b42029: Access control per model and per API key. Models disabled in the dashboard are no longer routed (chat, embeddings, images, TTS, STT and video answer 403 `model_disabled`; combos skip them). An API key can carry model rules (allow or deny glob patterns, matched under every provider prefix and alias; allowing a combo allows its members) and limits (requests per minute, tokens per day, spend per month) answered with 429 and Retry-After. `/v1/models` lists only what the key may call. Both are set on the key's page in the dashboard.

### Patch Changes

- b907e4e: Failures that arrive with HTTP 200 now fall back like any other error. A stream is read ahead (up to 15 s, `STREAM_READ_AHEAD_MS`) until its first event that carries an answer. An error event, an overloaded or quota message, `choices: null`, a role-only stream that ends, or a failing `finish_reason` (such as GLM's `model_context_window_exceeded`) becomes an error before the client sees the 200. The next account or combo member is then tried. Non-streaming bodies get the same check. While the upstream is silent, SSE clients get a `: keepalive` comment every 15 s (`STREAM_KEEPALIVE_MS`, 0 turns it off). When a client disconnects mid-stream, the tokens streamed so far are still recorded, and the request detail is marked `aborted`.

## 0.18.0

### Minor Changes

- b89bfca: New "ADHD-friendly answers" output mode on the Token Saver page, next to Caveman and Ponytail, adapted from the MIT-licensed [i-have-adhd](https://github.com/ayghri/i-have-adhd) skill. When on, RedRouter adds a system instruction that asks the model to lead with the next action, number multi-step work in the fewest steps, and end with one concrete next action that takes under two minutes. `lite` covers those rules; `full` (the default) also suppresses tangents, restates progress every turn ("Step 3 of 5 done…"), gives specific time estimates, makes finished work visible, and runs a pre-send check. The instruction works for every wire format (Chat, Responses, Claude, Gemini, Kiro) and stays active until the user says "stop adhd mode" or "normal mode" in the conversation. It is off by default. It can be set globally or per API key (`adhdEnabled`, `adhdLevel`), it is added after Caveman and Ponytail when those are also on, it is skipped when a request sends `x-red-router-token-saver: off`, and it appears as `ADHD:<level>` in the request's token-saver log line.

## 0.17.0

### Minor Changes

- fb804fb: `GET /v1/catalog` returns the `/v1/models` catalog grouped by provider, the combos, and the models RedRouter recommends for the connected accounts: `{ version, groups: [{ provider: { id, slug, prefix, name, category, subscription, connections }, models }], combos, recommended: { default, fast, review, systemone, vision? } }`. Each recommendation is `{ id, name, provider: { slug, name }, reason }` (or `null` when nothing connected fits). `default` is the strongest connected coding model and `fast` the cheapest capable fast model, from documented ranking tables by model family (Claude Fable > Claude Opus > GPT-6 Sol > … for `default`; GPT-6 Luna > Gemini Flash > Claude Haiku > … for `fast`), newest version first, a subscription or free account before a metered API key serving the same model. `review` is the review variant of a model with `parameters.modes: ["review"]`, otherwise the default; `systemone` is the first JEV model on `/v1/systemone`; `vision` is present when a connected model reads images. The endpoint uses the same API-key scoping and catalog version (`X-RedRouter-Catalog-Version`) as `/v1/models`, and accepts `?for=redcode` and `?variants=expand`. `GET /v1/capabilities` advertises it under `catalog.catalog_endpoint` and `catalog.recommendations`.
  
  The dashboard gains a "Recommended setup" (Combos page, and a new "Organize models" step in the setup wizard) that previews and creates `default`, `fast` and `review` combos from those recommendations, with fallbacks across the connected providers. Running it again updates those combos in place instead of duplicating them. The Cursor and Claude presets stay available.
- b6f4cb2: `/v1/models` lists one entry per base model. Codex `-review` ids fold into their base entry as `parameters.modes: ["review"]`. Antigravity (`gemini-3.8/3.7/3.6-flash-low|medium|high`), Grok CLI (`grok-4.5-low|medium|high`), Kiro (`-thinking`, `-agentic`, `-thinking-agentic`) and Cursor (`-thinking`) variant ids fold into the base entry's `thinking_levels` (Kiro's `agentic` becomes a mode). Each base entry lists what it absorbed under `variants: [{ id, name, level?, mode?, aliases? }]`, and `/v1/models/{id}` resolves a variant id to that base entry.
  
  Variant ids keep routing. A base id with a level now routes to the variant that serves it, through an explicit per-model table where the upstream models differ: `gemini-3.8-flash(high)` calls `gemini-3.8-flash-high`, `grok-4.5(low)` calls `grok-4.5-low`, `claude-sonnet-4.5(thinking)` on Kiro calls `claude-sonnet-4.5-thinking`, and a bare `gemini-3.7-flash` calls its medium variant.
  
  Older clients can list every variant as its own entry with `GET /v1/models?variants=expand` or the `catalog.variants: "expand"` setting (default `collapse`); `GET /v1/capabilities` reports it under `catalog.variants`. The unused `quotaFamily` model field and the dead `withCodexReviewModels` helper are removed.
- 4d082cf: `/v1/models` lists readable ids: `<slug>/<model>` (for example `claude-code/claude-opus-5`, `copilot/gpt-4o`, `codex/gpt-5.5`) instead of the short codes (`cc/`, `gh/`, `cx/`). Every entry now carries `name` (the model's display name), `provider` (`id`, `slug`, legacy `prefix`, display `name`, `category`, `subscription`) and `aliases` (the legacy id, for example `cc/claude-opus-5`, so clients can migrate saved ids); `owned_by` is the slug. Combos add `name` and `provider: { id: "combo", name: "Combo" }`; models from a remote RedRouter keep the remote's `name` and `provider` and add `via: "red-router"`. `/v1/models/{id}` also finds an entry by a legacy id.
  
  Every provider token routes: slug, id, alias, extra aliases and the dashboard badge code. Legacy short codes keep working forever. This fixes `pa/` (Perplexity Agent) and `voyage/` (Voyage AI), which were listed but fell through to the OpenAI upstream, and `mmf/`, which a hidden duplicate provider shadowed so it never reached MiMo Free. Built-in tokens, slugs included, take precedence over a custom node prefix that uses the same name.
  
  Clients that must keep the old ids can set `catalog.prefixStyle: "short"` (`PATCH /api/settings`); `GET /v1/capabilities` reports the active style under `catalog.prefix_style`.

## 0.16.1

### Patch Changes

- a3bd1d8: The Claude quota auto-ping now advertises the same Claude Code version as routed requests: the `RED_ROUTER_CLAUDE_CODE_VERSION` pin, else the version adopted from an upstream `claude_code_version_too_old` answer, else the built-in one, resolved on every ping.

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
