---
"@reddb-io/red-router": patch
---

Keep Friday's per-user scoping when importing a RedRouter v0.33.0 install: the owners of connections, API keys and combos, the scope and SSO settings, per-owner overrides and per-user preferences are staged (no secrets) under the `friday_legacy` namespace for the future users/tenants model instead of being dropped, and the import report warns when Friday admin keys are imported with this build's management scope.
