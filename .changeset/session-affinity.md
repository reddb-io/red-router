---
"@reddb-io/red-router": minor
---

Add per-session combo member stickiness. Requests carrying `x-session-affinity` or `x-parent-session-id` (a subagent is grouped with its parent) are served by the combo member that last served that session, for fallback, round-robin, smart and auto combos, until the member fails or the session is idle for 30 minutes; requests without them keep the combo's own rotation. Both headers are now read as session ids right after `x-session-id`, and OpenAI upstreams receive the session as `prompt_cache_key` when the client did not set one. `/v1/capabilities` reports `session.per_session_stickiness: true`, `session.affinity_headers`, `session.affinity_ttl_ms` and `session.prompt_cache_key: true`.
