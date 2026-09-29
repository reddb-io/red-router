---
"@reddb-io/red-router": patch
---

Stop losing the provider prompt cache when a long conversation gets compacted: once the history has to be trimmed, the router now keeps cutting at the same message for that conversation (and cuts a little deeper the next time it has to move), instead of sliding the window and rewriting the start of the prompt on every request. In a 48-turn simulation the prompt start changed 9 times instead of 46.
