---
title: "Cache Prefix Stability"
lastUpdated: 2026-09-29
---

# Cache prefix stability

Providers cache by exact prefix: `tools`, then `system`, then the messages in order. A change anywhere
in that prefix between turn N and turn N+1 of an agent tool-loop (or, for Anthropic, a change of the
thinking parameters) makes the provider re-write everything after it into its cache instead of
reading it.

The contract is executable: `tests/redrouter/native/cache-prefix-stability.test.ts` runs every
transformation RedRouter can apply before dispatch over a synthetic 12+ turn tool-loop (Claude
`messages` with and without client `cache_control`, OpenAI chat, Responses `input`), keeping the
per-session state a real session would keep, and compares turn N's transformed prefix with turn N+1's.
The last test prints the results table. Every case is `stable` (asserted) or `known-unstable`
(asserted to be unstable, with the first divergent index in the assertion message) so that the fix
slice (X-CACHE3) flips it to `stable` when it lands.

`LIVE_TAIL = 1`: the newest message of turn N may differ in turn N+1. A divergence at
`msg i/N` means message `i` of turn N's `N` transformed messages changed; `N - i` messages are
re-written for nothing.

## The evidence signature

Operator data: ~700k conversation tokens re-written on every request, a constant ~19k (system +
tools) read, one request that read 706k, and a body ~5.6% smaller than the client's.
"System and tools read, everything after them re-written" is exactly the signature of a change in
**thinking parameters** (Anthropic keeps `tools`/`system` cached and invalidates the messages), and
also of anything that rewrites early messages every turn. Ranked suspects, cheapest to check first:

1. **Reasoning level chosen per turn** (`src/sse/handlers/chat.ts:735` -> `applyReasoningLevel`,
   fed by the autopilot `planReasoning`). The messages/system/tools prefix stays byte-identical
   (`stable` rows), but `output_config.effort` / `reasoning` flips with the level; the test reports
   this separately as `thinking params`. Check the autopilot decision per request in the logs.
2. **Reactive context compaction** (`open-sse/handlers/chatCore.ts:2125-2151` triggers at 70% of
   the window; ~700k is 70% of a 1M window). See `compressContext` rows below: the crossing rewrites
   the whole history once, and the `purifyHistory` sliding window rewrites it on every turn.
   Look for `Proactive compression triggered` / `Context compressed` lines in the operator's logs.
3. Per-position compression that reaches Claude through a stacked pipeline (`aggressive`), see below.

## Results (turns 3..14, `LIVE_TAIL = 1`)

`first div` is the worst transition: first differing message / messages of turn N.

| Transformation | Result | first div | Cause (file:line) | Recommended fix (X-CACHE3) |
| --- | --- | --- | --- | --- |
| Reasoning level flips per turn: thinking params | known-unstable | `output_config`/`reasoning` changed | `src/sse/handlers/chat/reasoningLevel.ts`, `chat.ts:735` | Pin the level per conversation (session key), change only when the operator asks. Messages/system/tools are stable. |
| `compressContext` crossing the 70% threshold | known-unstable | msg 2/17 | `chatCore.ts:2125-2151`, `contextManager.ts:564` (`trimToolMessages`) | One full re-write is unavoidable at the crossing; make it sticky (remember the trimmed prefix per session, re-apply it, extend with new messages). |
| `compressContext` purifyHistory | known-unstable | msg 1/11 | `contextManager.ts:623-642` (`keep` shrinks 30% per pass from the total size) | Compact in large monotone steps (drop to ~50% once, then hold the same cut for many turns) and persist the cut per session. Layer 1 alone (trim) is `stable` in steady state. |
| Default pipeline `session-dedup+lite` on Responses `input` | known-unstable | msg 8/11 | `compression/lite.ts:160-164` (`currentTurnStart`), `bodyAdapter.ts:28-34,118` | `function_call` items are not messages, so the "current turn" is the whole loop; when the next assistant reply lands every result is cut to 2000 chars at once. Treat `function_call` as an assistant boundary in the adapter, or turn the live zone on for caching providers (see live zone). |
| `session-dedup` with a shared footer, Responses `input` | known-unstable | msg 8/11 | `engines/session-dedup/index.ts:242,335-342` (same current-turn rule) | Same adapter fix. On Claude/OpenAI chat it is `stable` (the current turn is only the tail). |
| `aggressive` (mode on non-caching, or stacked engine/combo anywhere) | known-unstable | msg 7/12, Claude msg 0/27 | `compression/progressiveAging.ts:105-109` (`distanceFromEnd`), `types.ts` `DEFAULT_AGGRESSIVE_CONFIG` | Never age by position for caching providers: `getCacheAwareStrategy` only downgrades the single MODE (`cachingAware.ts:120-125`, `strategySelector.ts:255-256`); stacked steps and combos still run `aggressive`. Filter position/query dependent engines out of stacked pipelines for caching contexts. |
| `deterministicOnly` | dead flag | - | `cachingAware.ts:33,124,132`: no module reads it (guarded by a test) | Consume it: caching context => drop `aggressive`, `relevance`, `read-lifecycle` from the pipeline. |
| `relevance` on Claude bodies | known-unstable | msg 0/25 | `engines/relevance/index.ts:112-118` (query = last user message) | Score against a frozen query (first request of the loop) or exclude for caching contexts. |
| `read-lifecycle` (repeated Read of one path) | known-unstable | msg 2/7 | `engines/readLifecycle/index.ts:138-145` | By design; opt-in. Exclude for caching contexts or only collapse reads older than a fixed age. |
| Auto-trigger by size (off -> lite) | known-unstable | msg 3/16 | `strategySelector.ts:160` (mode picked from the request's total estimated size) | Latch the mode per session; combine with the live zone so the crossing only affects new items. |
| Live zone ON, client moves `cache_control` (Claude Code) | known-unstable | 0/12 hits | `liveZone.ts:188-194,391`: raw digests include `cache_control` | Digest with `cache_control` stripped. Otherwise the reuse never hits for Claude Code. |
| Live zone ON, no session id | known-unstable | 0/12 hits | `liveZone.ts:127-133` | Derive a stable id (first-message hash) when the client sends none. |
| `injectHint` on OpenAI chat / Responses targets | known-unstable | msg 7/12, 6/11 | `decision/injectHint.ts:49-53,69-87,89-108`, applied at `chatCore/toolDecision.ts:151` | The hint goes into the last `user`-role message, which in these formats is the start of the loop, not the tail; it changes with the suggested tool. Append it as a NEW trailing item (or to the last item). Claude bodies are `stable`. |
| `injectMemory` cache-safe splice (OpenAI chat) | known-unstable | msg 7/13 | `src/lib/memory/injection.ts:264,228` | Anchor on the tail, or freeze the memory block per session. Off by default. |
| `injectMemory` system-first with per-request retrieval | known-unstable | system changed | `injection.ts:160` (`injectSystemFirst`) | Freeze the retrieved memories for the session. Same memories every turn is `stable`. |
| `prepareClaudeRequest`, signed thinking in history | known-unstable | msg 7/9 | `translator/helpers/claudeHelper.ts:539-543,587-600` | The latest assistant keeps its thinking block, the previous one is rewritten to `redacted_thinking`: bytes change one turn after being cached. Rewrite only blocks without a genuine signature (as the passthrough path already does, `passthroughHelpers.ts:156`). |
| `extractSystemRoleMessages` with mid-conversation reminders | known-unstable | system changed | `chatCore/claudeSystemRole.ts:104-160` | A new `system`/`developer` message anywhere edits the top-level `system`. Keep them in place (the mid-conversation path already exists) or convert them to trailing user text. |
| `applyOutputStyles`, content trips the auto-clarity bypass | known-unstable | msg 0/18 (system) | `compression/outputMode.ts:96-126`, `outputStyles/apply.ts:207` | The bypass scans the LAST 3 messages (tool output included) so the style block appears and disappears. Latch per conversation and scan user text only. |

Stable (asserted): `standard`(caveman), `ultra`, `rtk`, `codex-responses` engine, `headroom`,
`ionizer`, `ccr` (with the retrieve tool), `session-dedup`/`lite` on Claude and OpenAI chat,
`aggressive` requested as a mode for caching providers (downgraded to `standard`), `stacked
rtk+caveman`, live zone ON with a stable session and unmoved markers (11/12 hits, also fixes the
`lite`/`aggressive` cases), `injectHint` on Claude, `injectCustomSystemPrompt`, memory system-first
with constant memories, `hoistLeadingTextSystemMessages`, `cloakThirdPartyToolNames` +
`obfuscateInBody`, `compressContext` layer-1 steady state, `applyReasoningLevel` for messages/system/tools.

Default-path facts worth knowing: without an opt-in header (`allow-lossy`, `engine:<id>`, a named
combo) every lossy plan is replaced by `stacked[session-dedup+lite]`
(`compression/lossyRequestPolicy.ts:44-70`); both engines are inert on Claude `tool_result` blocks.

## Not exercised in isolation

- `llmlingua` (spawns a model worker that keeps the process alive), `llm` (no-op default backend),
  `omniglyph` (image transport), quantum lock and risk gate (default off).
- `injectSkillsWithMetadata` (`src/lib/skills/injection.ts:345-355,447-450`) scores registered skills against
  the WHOLE conversation text and injects up to 5 as `tools`: if it fires, `tools` (the very front of
  the prefix) can change as the conversation grows. It only runs for non-streaming requests with the
  skill registry enabled, so it needs the DB-backed registry.
- `translateRequest` OpenAI/Responses <-> Claude beyond `prepareClaudeRequest`, provider system
  transforms (`applyProviderSystemTransforms`), executor-level body transforms of non-Claude providers,
  `sortToolsByName` (deterministic), output token budget (`max_tokens`).
