---
"@reddb-io/red-router": minor
---

Headless background service + docs: `red-router service install|status|uninstall` runs the gateway under systemd --user (Linux) or launchd (macOS), surviving reboots and crashes. Services bind 127.0.0.1 by default; `--expose` (or `-H 0.0.0.0`) opens the gateway to the subnet. READMEs now teach the `npx -y @reddb-io/red-router@latest` flow.
