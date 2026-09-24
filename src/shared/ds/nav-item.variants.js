// GENERATED from vendor/ds/kits/app/nav-item.variants.ts by scripts/sync-ds-variants.mjs — do not edit.
// NavItem's styling. See button.variants.ts for the split, the colour rule and
// the spatial rule.
//
// The active state wears the shared selection language (DESIGN.md,
// "Interactive states"): a neutral surface, full-weight foreground ink, and a
// 2px Brand-red bar on the start edge. The bar's colour is the `primary` role
// the Themes reassign; its width is a plain border width, like every other
// rule the Kits draw. Every item carries the same edge, transparent until it
// is current, so moving the current page shifts nothing. The Brand red never
// fills the item — it marks the primary action, and here it only points.
//
// A horizontal rail of items (BottomNavigation) moves the bar to the edge it
// sits against through its own slot class.
//
// Opacity is doing the work an extra surface token would otherwise do, which
// is the same choice button.variants.ts made and for the same reason: the
// Tokens Layer ships no second surface yet.

import { tv,                   } from "tailwind-variants";

const ACTIVE = {
  /** Where you are. */
  true: { root: "border-primary bg-foreground/10 font-medium text-foreground" },
  /** Everywhere else you could go. */
  false: { root: "border-transparent bg-transparent text-ink-muted hover:bg-foreground/8 hover:text-foreground" },
}         ;

const DISABLED = {
  /** Present, visibly unavailable, and unreachable by pointer or by tab. */
  true: { root: "pointer-events-none opacity-50" },
  false: { root: "" },
}         ;

export const navItem = tv({
  slots: {
    root: "inline-flex w-full items-center gap-[var(--reddb-spatial-gap-md)] rounded-s-none rounded-e-md border-s-2 px-[var(--reddb-spatial-inset-sm)] py-2 text-sm leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
    icon: "shrink-0",
    label: "truncate",
    trailing: "ms-auto shrink-0",
  },
  variants: { active: ACTIVE, disabled: DISABLED },
  defaultVariants: { active: false, disabled: false },
});

                                                           
