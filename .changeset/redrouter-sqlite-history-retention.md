---
"@reddb-io/red-router": patch
---

Add explicit SQLite operational-history cleanup windows of 7, 14 or 28 days, or Off, with a manual cleanup action. Preserve business configuration and financial records, retain the separate usage policy, prune completed task history, and make legacy cleanup writers respect the selected mode.
