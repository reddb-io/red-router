---
"@reddb-io/red-router": patch
---

Keep the Linux tray running across unattended upgrades by supervising it in its own graphical-session user service. Confirm desktop registration before reporting readiness, restart after native-helper or watcher failures, expose tray state in service status, and retain diagnostics in the journal. Desktop autostart now starts the supervised tray instead of leaving it inside an installer's process group.
