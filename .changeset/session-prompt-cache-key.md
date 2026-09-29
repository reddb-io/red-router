---
"@reddb-io/red-router": patch
---

Prompt caching for Codex and OpenAI-format requests keeps every turn of a conversation together: the router sets `prompt_cache_key` per conversation and key holder (`rr-…`) instead of a hash of the shared prefix, so unrelated conversations no longer pile onto one cache and one conversation's turns land on the same one. A key the client sends is never replaced. The reasoning autopilot also holds its thinking level for at least eight turns on Claude conversations, because every change of thinking settings throws that conversation's cache away (moves upward for trouble are still immediate).
