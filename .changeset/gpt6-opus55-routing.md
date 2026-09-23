---
"@reddb-io/red-router": minor
---

Route GPT-6 Sol/Luna and Claude Opus 5.5 at their full effort range:

- **Codex**: advertise Codex 0.155.1 (User-Agent, `version` header and the `/models?client_version=` query), which the backend requires before it serves GPT-6 Sol and Luna. Add `gpt-6-sol` and `gpt-6-luna` (272K context via Codex, 128K output, effort none/low..max) with pricing: Sol $2/$10 (cache read $0.20; >272K $4/$15), Luna $0.10/$0.50 (cache read $0.01; >272K $0.20/$0.75). Astra stays at $10/$50 (>272K $20/$75).
- **Effort**: GPT-6 keeps `max` on every provider instead of dropping to `xhigh`, and `minimal` (which GPT-6 does not take) rises to `low`. Claude models that take `xhigh` (Opus 4.7+, Opus 5.x, Sonnet 5, Fable 5.x) receive it as-is instead of `high`; a disable request on Opus 5.5 or Fable 5.1 clamps to `low` instead of the invalid `minimal`.
- **Claude thinking display**: the adaptive thinking block keeps the client's `display`, and models whose thinking cannot be disabled (Opus 5.5, Fable 5.1) get `display: "summarized"` so thinking text is no longer empty.
- **Claude Code version**: when Anthropic answers `claude_code_version_too_old`, the router adopts the version it names (only upward, process-wide; `RED_ROUTER_CLAUDE_CODE_VERSION` pins it) and resends the request once before any output, with the User-Agent and billing header recomputed.
