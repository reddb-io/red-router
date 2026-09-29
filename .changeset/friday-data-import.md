---
"@reddb-io/red-router": patch
---

Import a RedRouter v0.33.0 install on first start: providers, API keys (with quotas, tags, flat model ids and admin role), combos, aliases, the login password and usage history move from `data.sqlite` into the current database. The original file is backed up and never modified, and anything without a mapping yet is listed in `friday-import-report.json`.
