---
"@reddb-io/red-router": patch
---

`X-RedRouter-Catalog-Version` now changes as soon as a combo is created, edited or deleted, a model is disabled or re-enabled, or an API key's rules change. Before, it could stay stale for up to 15 s, so clients watching it kept an outdated model list. Releases now also run an end-to-end routing check against fixture upstreams (`cli/scripts/e2e-routing.mjs`).
