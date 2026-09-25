---
"@reddb-io/red-router": patch
---

The dashboard now takes the design system the way its README says. `design-system.manifest.json` pins v2026.09, and the official Sync lays it out under `vendor/ds`, replacing the hand-extracted files. Future versions arrive as a reviewable diff. The Brand fonts (Space Grotesk, JetBrains Mono) are now served from the design system's own files instead of Google Fonts, so builds no longer fetch them. Nothing changes visually: the tokens, theme and component contracts are byte-for-byte the same.
