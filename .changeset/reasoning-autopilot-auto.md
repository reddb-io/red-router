---
"@reddb-io/red-router": minor
---

Restore the reasoning autopilot, the "auto" effort of the dual reasoning mode. A request with `x-red-router-reasoning: auto` (RedCode's `auto` effort variant), or a key or combo covered by `settings.reasoningAutopilot`, lets System One's read of how much deliberation the next step needs choose the effort level; a level the client states itself (`off`, a level, or a hint `effort`) is never overridden. The level holds through a turn's tool loop, is applied to the client's own effort field so the existing reasoning pipeline translates it per provider, and is reported in `X-RedRouter-Reasoning`. `/v1/capabilities` now advertises the reasoning contract and the served-model and cost headers, which switches on RedCode's `reasoning-auto`, `served-model` and `cost` features.
