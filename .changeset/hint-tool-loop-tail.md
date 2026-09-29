---
"@reddb-io/red-router": patch
---

Keep the provider prompt cache warm through tool loops: the routing hint is now added as its own trailing message when the request ends in a tool result (OpenAI chat and Responses/Codex), instead of rewriting the user message that started the loop on every turn.
