---
"@reddb-io/red-router": patch
---

Dashboard: remove the leftover 9English/9Remote sidebar entries and promo modal. The displayed version now reads the running server via /api/version (runtime truth) instead of a build-time constant, and the update checker queries the correct npm package (@reddb-io/red-router) instead of the pre-rebrand name.
