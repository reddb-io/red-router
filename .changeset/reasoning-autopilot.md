---
"@reddb-io/red-router": minor
---

Add the reasoning autopilot: per turn it raises or lowers how much the model thinks, from the decision model's deliberation verdict plus request signals (plan mode, stalled or failing tool loops, explicit "think hard", tool continuations, session titles), within a configurable floor and ceiling, with per-session hysteresis to protect prompt caching. Opt in per API key or combo — direct model requests included — in off/shadow/enforce modes; applies on translated routes and the Claude Code passthrough; `x-red-router-reasoning` forces a level or opts out per request, and `X-RedRouter-Reasoning` reports the choice.
