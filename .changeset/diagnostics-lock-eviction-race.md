---
"@reddb-io/red-router": patch
---

Fixed a race in the diagnostic log lock. When a launcher had crashed while holding the lock, launchers that started together could remove each other's live lock. One of them then printed "Cannot write diagnostic log" and lost its line. Each dead lock is now removed by exactly one launcher.
