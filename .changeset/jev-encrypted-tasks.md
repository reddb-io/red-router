---
"@reddb-io/red-router": patch
---

Skip System One decisions (model, tool and reasoning autopilot) for delegated agent tasks whose content is encrypted, where the decision model would only read ciphertext, and price JEV under its OpenRouter (`typesafe/jev-1.13`) and OpenCode Zen (`jev-1.13-free`) ids so decision rows carry the right cost.
