---
"@reddb-io/red-router": patch
---

The Claude quota auto-ping now advertises the same Claude Code version as routed requests: the `RED_ROUTER_CLAUDE_CODE_VERSION` pin, else the version adopted from an upstream `claude_code_version_too_old` answer, else the built-in one, resolved on every ping.
