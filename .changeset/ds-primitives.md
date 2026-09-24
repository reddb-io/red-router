---
"@reddb-io/red-router": patch
---

Buttons, cards and badges now render the design system's own appearance contracts (`button`, `card` and `badge` from design-system v2026.08.5) instead of local class lists.

- **Buttons**: the secondary button is outlined instead of filled, the ghost button is text only, and the weight is medium. Heights come from the compact density, so `sm`, `md` and `lg` differ again. On touch screens every button keeps at least a 44px target.
- **Danger and success buttons** use the design system's feedback colors instead of a solid red or green. Red now only ever means danger, and it is the feedback red, not the brand accent.
- **Loading** uses the design system's spinner and sets `aria-busy`.
- **Cards** sit flat on the page background with a thin border and density-based padding, and their title and subtitle use the design system's type.
- **Badges** are small rounded rectangles instead of pills. Status badges (success, warning, error, info) use the design system's feedback colors. The `neutral` variant, which some pages used but which had no style, now renders.
