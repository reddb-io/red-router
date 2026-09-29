---
"@reddb-io/red-router": patch
---

Fix RedCode's System One detection: `/v1/capabilities` now reports `systemone.available` (true when the key's catalog lists a System One model), and `GET /v1/models/systemone` returns those models as an OpenAI list with `id_format`.
