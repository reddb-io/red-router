---
"@reddb-io/red-router": minor
---

Claude Code now works through RedRouter like a direct connection to Anthropic.

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
