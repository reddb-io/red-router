---
"@reddb-io/red-router": patch
---

Dark mode: fixed the bright white lines around cards, sections and the sidebar. The design system defines `border-subtle` only as a light-scheme color (neutral-200, almost white). The dashboard used it in dark mode too. It now uses the dark base border, softened. Borders with no color class also follow the design system now, instead of Tailwind v4's default `currentColor`, which is white in dark mode.
