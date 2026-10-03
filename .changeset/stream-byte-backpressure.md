---
"@reddb-io/red-router": patch
---

Apply stream queue budgets in bytes instead of chunks so slow clients cannot retain oversized SSE buffers. Adapted from the defect described in OmniRoute PR 15277 using standard byte-length queuing strategies.
