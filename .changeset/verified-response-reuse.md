---
"@reddb-io/red-router": minor
---

Add optional decision-model verification for similar cached responses, with connection-bound model selection inside Settings → Cache → Response reuse. Identical requests bypass evaluation; incompatible context, denied permissions, invalid decisions and timeouts fall back to normal generation. Existing similarity settings remain unchanged and verification defaults to off. Show process-scoped verification activity and known evaluation costs, and allow saving disabled cache settings.
