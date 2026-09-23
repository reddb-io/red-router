---
"@reddb-io/red-router": minor
---

`/v1/models` lists one entry per base model. Codex `-review` ids fold into their base entry as `parameters.modes: ["review"]`. Antigravity (`gemini-3.8/3.7/3.6-flash-low|medium|high`), Grok CLI (`grok-4.5-low|medium|high`), Kiro (`-thinking`, `-agentic`, `-thinking-agentic`) and Cursor (`-thinking`) variant ids fold into the base entry's `thinking_levels` (Kiro's `agentic` becomes a mode). Each base entry lists what it absorbed under `variants: [{ id, name, level?, mode?, aliases? }]`, and `/v1/models/{id}` resolves a variant id to that base entry.

Variant ids keep routing. A base id with a level now routes to the variant that serves it, through an explicit per-model table where the upstream models differ: `gemini-3.8-flash(high)` calls `gemini-3.8-flash-high`, `grok-4.5(low)` calls `grok-4.5-low`, `claude-sonnet-4.5(thinking)` on Kiro calls `claude-sonnet-4.5-thinking`, and a bare `gemini-3.7-flash` calls its medium variant.

Older clients can list every variant as its own entry with `GET /v1/models?variants=expand` or the `catalog.variants: "expand"` setting (default `collapse`); `GET /v1/capabilities` reports it under `catalog.variants`. The unused `quotaFamily` model field and the dead `withCodexReviewModels` helper are removed.
