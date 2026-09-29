---
"@reddb-io/red-router": patch
---

The startup banner now spells RedRouter instead of the inherited product name, shell completions (bash, zsh, fish) are registered for the `red-router` binary and read the completion cache from RedRouter's own data directory (they targeted a command that does not exist and a folder that is never written), and the hints the CLI and dashboard print (`red-router runtime repair`, `red-router env get`, `red-router contexts use default`, the MITM Kiro instructions, …) name the command you actually run.
