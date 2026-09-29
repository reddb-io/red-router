---
"@reddb-io/red-router": patch
---

Restore `X-RedRouter-Catalog-Version`: a 16-hex digest of the catalog a key sees, identical on `/v1/models`, `/v1/catalog` and `/v1/capabilities`, so RedCode re-reads its cached model list when it changes.
