---
"@reddb-io/red-router": patch
---

Preserve billing failures and numeric HTTP error codes through chained Router SSE streams instead of reporting them as generic gateway failures.

Use the native Claude executor deadline for slow response starts and honor explicitly configured connection timeouts instead of cancelling every streaming request at 110 seconds.

Keep request-specific OpenRouter token-reservation refusals from cooling down otherwise usable models and connections, including through a Router peer.
