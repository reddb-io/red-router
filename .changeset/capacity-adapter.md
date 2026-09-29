---
"@reddb-io/red-router": minor
---

Capacity adapter, ported from RedRouter v0.33.0 / 9router. In Settings → Routing you can name fallback models per input type (images, audio, video). When a request carries media and no member of the combo can read it, those models are tried first instead of the request failing; a combo that already has a capable member is never changed, a pool member that cannot take the media is never used, and nothing happens unless a pool is enabled and lists models (there is no built-in default, since every pool member is a model on one of your accounts).
