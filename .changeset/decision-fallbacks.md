---
"@reddb-io/red-router": minor
---

Routing decisions no longer stall when JEV is unavailable.

- **Local score fallback.** A deterministic local score (built from explicit "think" requests, plan mode, stalls, tool errors, feedback, hard or trivial wording, ask length and context size) stands in whenever JEV times out, errors, or has its breaker open:
  - **smart combos** pick a tier from it;
  - **auto combos** send a clearly hard turn to their priciest member and a clearly easy one to the cheapest;
  - **the reasoning autopilot** uses it on a session's first turn.
- **New smart-combo modes.** `smartMode: "hybrid"` asks JEV only when the local score sits near a tier edge. `"heuristic_first"` asks JEV only when no signal fired.
- **Total-cost tie-break.** Auto-combo ties are broken by what the whole request would cost (prompt plus expected answer, with the warm-cache discount), not by input price alone.
- **Cache affinity.** Moving away from the member whose prompt cache is warm needs a clearer verdict (`cacheSwitchStrength`, 0.75 by default).
- **New Token Saver option: "Drop irrelevant tool output"** (opt-in). JEV judges which older tool outputs the current request still needs, and replaces the rest with a one-line note. Each output is judged once; errors and the two latest outputs are always kept.
