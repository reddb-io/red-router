---
"@reddb-io/red-router": patch
---

Keep OpenAI-compatible model tests responsive when upstream streams or response bodies stall. Enforce diagnostic deadlines, stop at completed SSE events, release canceled readers, propagate client cancellation, and show progress beside the tested model with persistent timeout feedback.
