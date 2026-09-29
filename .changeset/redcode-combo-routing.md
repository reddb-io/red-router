---
"@reddb-io/red-router": patch
---

Advertise what each combo does on `/v1/models`: `strategy` (v0.33.0 names, `fallback` for priority) and `routing_strategy` (this build's name), plus the ordered `members`, so RedCode knows which combos accept its routing hints and which models they can reach.
