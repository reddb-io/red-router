---
"@reddb-io/red-router": patch
---

MCP model suggestions no longer point at models whose provider is out of quota. A model counts as usable only while one of its accounts is on, has no active lock for that model (or for the whole account), and has quota left according to the provider's last report. These are the same rules account selection uses. A model's status is now `quota_exhausted`, `rate_limited`, `unavailable` or `disabled` with an `until` time and an `accounts: {available, total}` count. `recommend_models` gives `quota_exhausted` as the reason to move off the current model. The MCP schema version is now 4.
