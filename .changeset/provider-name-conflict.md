---
"@reddb-io/red-router": patch
---

Refuse to replace a provider key silently: creating an API-key connection whose provider and name already exist now answers 409 `PROVIDER_NAME_CONFLICT` with the existing id, unless the request sets `allowOverwrite: true`. OAuth re-login and edits of an existing connection still update it in place. (Found by the 9router study; 9router made the same change upstream.)
