---
"@reddb-io/red-router": patch
---

Honour `x-red-router-token-saver` (RedCode): `off` keeps the prompt intact for a request whose compaction or validation must see all of it, `on` asks for the panel default. It maps onto OmniRoute's per-request compression override, which still wins when `x-omniroute-compression` is sent, and `/v1/capabilities` advertises `token_saver_header`.
