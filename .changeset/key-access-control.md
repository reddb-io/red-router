---
"@reddb-io/red-router": minor
---

Access control per model and per API key. Models disabled in the dashboard are no longer routed (chat, embeddings, images, TTS, STT and video answer 403 `model_disabled`; combos skip them). An API key can carry model rules (allow or deny glob patterns, matched under every provider prefix and alias; allowing a combo allows its members) and limits (requests per minute, tokens per day, spend per month) answered with 429 and Retry-After. `/v1/models` lists only what the key may call. Both are set on the key's page in the dashboard.
