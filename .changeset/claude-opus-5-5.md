---
"@reddb-io/red-router": patch
---

Advertise Claude Code 2.1.280, the build Claude Opus 5.5 requires, and add Claude Opus 5.5 to the Claude provider with its capabilities (1M context, 128K output, always-on adaptive thinking) and pricing; forced `tool_choice` is downgraded to `auto` on Opus 5.5 and Fable 5.1, which reject it.
