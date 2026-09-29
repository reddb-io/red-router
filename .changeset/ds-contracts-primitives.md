---
"@reddb-io/red-router": patch
---

Bring the design system's component layer back: the pinned Kit appearance contracts are vendored with a hashed lock, and Button, Badge, Card, Input and Select render through them again instead of OmniRoute's Tailwind classes.
