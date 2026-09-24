---
"@reddb-io/red-router": patch
---

Status colors across the dashboard now come from the design system's feedback roles instead of raw Tailwind colors: errors, warnings, successes and notices use the RedDB danger, warning, success and info colors in both light and dark mode.

- Tinted status boxes, status text, borders and focus rings use the feedback surface, foreground and border colors.
- The dark-mode-only duplicates (`dark:text-green-400` and the like) are gone, because the design system colors already follow the color scheme.
- Grays and translucent black/white borders and backgrounds use the neutral roles (`ink-muted`, `muted`), and floating menus use the overlay surface.
