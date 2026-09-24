---
"@reddb-io/red-router": patch
---

Connection tests now show what happened on the wire instead of only "Valid" or "Failed": the HTTP status (e.g. `200 OK`, `401 Unauthorized`), total latency, response size, and the method and endpoint that were called, plus the reason when the test fails. When a test makes more than one request, for example an OAuth token refresh and then the probe, each request is listed with its own status, time and size. Query strings are never shown, so keys passed in a URL stay hidden.

This shows up in the Edit Connection dialog, in the one-by-one test on a provider page, and in the batch test results on the Providers page.
