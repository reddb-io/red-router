---
"@reddb-io/red-router": minor
---

In `/v1/models`, a combo's `parameters` now follow its routing strategy.

- **`fallback` combos** state their lead member's parameters. The lead is who serves unless it fails, so its context window, output limit and thinking settings are the ones to plan for.
- **Other strategies** (`round-robin`, `smart`, `auto`, `fusion`) may land on any member, so they keep the strictest member's parameters.
- **New fields:**
  - `parameters_basis` (`"lead"` or `"strictest"`) says which basis applies.
  - `parameters_strict` keeps the strictest parameters next to the lead's.
  - `member_parameters: [{ id, parameters }]` gives every member its own parameters.
- **When another member serves:** `X-RedRouter-Served-Model` names it. A client can switch to that member's entry in `member_parameters` without fetching the catalog again.
- **Unchanged:** `members` and the top-level `context_length`, `max_completion_tokens` and `capabilities` still describe the safe floor.
