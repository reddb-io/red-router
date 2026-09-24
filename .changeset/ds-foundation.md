---
"@reddb-io/red-router": patch
---

The dashboard now takes the design system's Tailwind 4 theme (`vendor/ds/theme.css`, from design-system v2026.08.5), so palette, radius, shadow, spacing, type and motion utilities resolve to the RedDB tokens instead of Tailwind's defaults.

- Surfaces are flat: the soft shadow under every card is gone, and raised surfaces use the design system's elevation shadow.
- The leftover orange from the 9router palette is gone: card hover, text selection, scrollbars, glows and focus rings now use the RedDB primary color.
- Corners follow the design system: controls `rounded-md`, cards and modals `rounded-lg`, replacing the one-off 10px and 14px radii in the shared components.
- Secondary text never uses the surface color `muted`; it uses `ink-muted`.
- The root element sets `data-density="compact"`, so the design system's spacing tokens apply.
