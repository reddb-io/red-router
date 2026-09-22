---
"@reddb-io/red-router": patch
---

Persist private, size-rotated operational logs in platform state directories; expose the current log with `red-router logs --path`, `red-router logs --open`, and the tray's Open log action. Capture server output even without --log and record launcher/tray failures, without recording interactive credential screens.
