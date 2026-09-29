---
"@reddb-io/red-router": patch
---

Add the prefix stability contract for provider prompt caching: a native test runs every transformation that can rewrite a request before dispatch (compression modes and engines, live zone, routing hint, reasoning level, context compaction, memory injection, Claude body preparation, system hoisting, output styles) over a multi-turn tool-loop and asserts whether turn N's prefix survives byte-identical in turn N+1, with the known-unstable cases and their first divergent message recorded, plus `docs/architecture/CACHE_PREFIX_STABILITY.md` with the causes and recommended fixes. Test and documentation only, no runtime behaviour change.
