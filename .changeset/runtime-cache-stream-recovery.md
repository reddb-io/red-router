---
"@reddb-io/red-router": patch
---

Separate exact and semantic cache entries by generation settings, including reasoning effort, output limits and tool policies. Honor cache bypass for reads and writes, preserve caller namespaces, exclude paused or incomplete results, and apply the configured idempotency window with replay isolated by API key.

Report premature streaming EOF as a failure, preserve Anthropic paused turns as incomplete Responses results, and bound the wait for trailing usage after generation finishes. Clean up completion timers and upstream streams on cancellation.

Refresh imported OAuth credentials with numeric expiry values consistently. Allow successful half-open probes to recover the provider breaker and keep missing thread, message or file references scoped to the request.
