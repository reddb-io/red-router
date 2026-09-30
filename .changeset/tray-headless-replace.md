---
"@reddb-io/red-router": patch
---

A tray started without a graphical display (for example by an upgrade run from a service) no longer stops the tray that is already on screen. It now checks for a display before taking the single-instance lock.
