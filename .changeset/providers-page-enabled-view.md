---
"@reddb-io/red-router": minor
---

The Providers page opens on the providers you enabled, and only those. Tabs switch to "Free sources" (every keyless source with its own switch, nothing pre-selected, an "Enable all free sources" button behind a confirmation, and a notice of the sources that handled requests in the last 90 days so you can turn them back on in one click) and "All providers" (a searchable catalogue with one Add action each). A provider whose connections are all switched off is not shown as enabled; find it under "All providers" → Manage. Compact mode follows the same rule. The page also lost its rainbow: 289 hard-coded palette colours (per-category tints, coloured badges and toggles) were replaced by the design system's neutral surfaces, a single neutral tag style and feedback colours only for real state; a test now fails if raw palette colours come back to the providers or models pages.
