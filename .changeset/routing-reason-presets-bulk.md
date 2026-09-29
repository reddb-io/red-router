---
"@reddb-io/red-router": minor
---

Routing failures now carry machine-readable headers: `X-RedRouter-Reason` (`model_disabled`, `model_not_allowed`, `api_key_limit`, `quota_exhausted`, `overloaded`, `no_active_credentials`) and `X-RedRouter-Retry-At`, with `X-9Router-Reason` / `X-9Router-Retry-At` as aliases for clients that already read the v0.33.0 names. The combos page gains bulk actions (select combos to delete them or change their strategy at once, reported per combo) and one-click default combos for Claude Code and Cursor, which only add what is missing and never overwrite a combo you built.
