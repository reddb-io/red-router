// GENERATED from vendor/ds/kits/base/badge.variants.ts by scripts/sync-ds-variants.mjs — do not edit.
import { tv,                   } from "tailwind-variants";

const VARIANT = {
  /** The default: present without claiming attention. */
  neutral: "border-transparent bg-muted text-foreground",
  /** Reserved for the one status that matters on a screen. */
  primary: "border-transparent bg-primary text-on-primary",
  /** The quietest form — the surface shows through. */
  outline: "border-muted bg-transparent text-foreground",
}         ;

export const badge = tv({
  base: "inline-flex items-center gap-[var(--reddb-spatial-gap-sm)] rounded-md border px-2 py-0.5 text-xs font-medium leading-none whitespace-nowrap",
  variants: { variant: VARIANT },
  defaultVariants: { variant: "neutral" },
});

                                                       
                                                                 

export const BADGE_VARIANTS = Object.keys(VARIANT)                           ;
