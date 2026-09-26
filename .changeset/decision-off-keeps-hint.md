---
"@reddb-io/red-router": patch
---

`x-red-router-decision: off` no longer drops a client's classification hint: the router's tool routing stays off, but an auto combo still picks its member from an `x-red-router-hint` deliberation sent in the same request, which is what redcode sends once its own System One has chosen the turn's tools. `/v1/capabilities` reports `decision.off_keeps_hinted_model: true`.
