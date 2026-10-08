---
"@reddb-io/red-router": minor
---

Add an opt-in, experimental RedDB/PostgreSQL persistence slice for combos and model-combo mappings. Keep SQLite as the default and retain node-local SQLite for other durable state. Include explicit maintenance initialization, empty-only snapshot import, readiness checks, recoverable local deletion cleanup and independent engine conformance in CI.
