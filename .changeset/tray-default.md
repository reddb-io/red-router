---
"@reddb-io/red-router": patch
---

The tray icon is now the default, and it stays current.

- **On by default.** `red-router serve` at an interactive desktop terminal also shows the tray icon; the server stays in that terminal. `--no-tray`, `RED_ROUTER_TRAY=0`, CI, pipes, services and headless sessions leave it off. `--tray` still runs the whole app in the background.
- **One icon, always the installed version.** A small lock records the running tray and its version. Starting a tray of a newer version replaces the old one instead of leaving a stale icon, and `red-router tray attach --replace` takes over on demand.
- **Upgrades refresh it.** Installing or upgrading the managed service now puts the new tray on screen right away, instead of at the next login.
