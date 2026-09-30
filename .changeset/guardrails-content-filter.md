---
"@reddb-io/red-router": minor
---

Guardrails, second slice (Settings → Security → Guardrails). A content filter with your own keywords (optionally whole-word) and restricted regexes, applied to requests and to non-streaming responses, that either blocks with a fixed `content_policy_violation` message (never revealing the rule) or just flags; a registry that lists every built-in guardrail with its stage and priority; assignments that turn guardrails on or off and reorder them globally, per key group and per key, with data-mutating guardrails (PII, credentials, media bridges) never enabled implicitly; and a 24-hour event log (guardrail and rule ids only, never matched text, kept 30 days). With nothing configured the pipeline behaves exactly as before, and the PII opt-in defaults are untouched. Streamed responses are not scanned on the response side.
