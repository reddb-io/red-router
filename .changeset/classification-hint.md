---
"@reddb-io/red-router": minor
---

Accept a client-side classification in the `x-red-router-hint` request header (`complexity`, `deliberation`, `needs_tool`, `tier`). Smart combos take the hinted tier instead of calling the classifier, auto combos take the hinted deliberation instead of asking System One for it, the effort ceiling uses it, and `needs_tool=false` skips the tool decision. Invalid hints are ignored whole; the request detail records what the hint replaced. `/v1/capabilities` now reports `decision.accepts_hint: true`, `decision.hint_header` and `decision.hint_keys`.
