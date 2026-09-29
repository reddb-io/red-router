---
"@reddb-io/red-router": patch
---

Asking for a Gemini model through the old `gc/` prefix (Gemini CLI, retired) now returns a clear `410 PROVIDER_RETIRED` that points to `antigravity/<model>`, instead of reaching Grok Build (which owns `gc/` now) and failing with "model not found". `gc/` and `if/` keep working for Grok Build and Qoder models.
