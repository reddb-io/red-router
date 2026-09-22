---
"@reddb-io/red-router": minor
---

Read deterministic request signals before asking the decision model: session-title calls go to the cheapest auto-combo member with no decision call, plan mode and stalled tool loops never land on the cheapest member, harness reminders and Codex/Claude Code boilerplate are stripped from the decision state, members that cannot hold the request's context or modality are left out of the question, and `x-red-router-decision: off` now also skips the model decision.
