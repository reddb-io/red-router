---
"@reddb-io/red-router": patch
---

More of the old prefix is gone. The agent skills are now `red-router-*` (auth, providers, models, combos-routing, …) with their catalog ids, folders and links moved to this repository, and the Skills page lives at `/dashboard/skills` (the old `/dashboard/omni-skills` address redirects there). "OmniGlyph" is now "Glyph", "OmniConductor" is "Conductor", and the VS Code extension guide and its links are removed. A test now fails if a skill folder, page or visible label carries the old prefix again.
