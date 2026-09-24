// GENERATED from vendor/ds/kits/base/select.variants.ts by scripts/sync-ds-variants.mjs — do not edit.
// Select's public appearance seam. The component keeps the platform's own
// popup and keyboard model while giving the closed control a canonical skin.

import { tv,                   } from "tailwind-variants";

export const select = tv({
  base: [
    "flex w-full h-[var(--reddb-spatial-control-height-md)] cursor-pointer",
    "rounded-md border border-control-edge bg-background",
    "px-[var(--reddb-spatial-inset-md)] text-sm text-foreground",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
    "aria-invalid:border-feedback-danger-border",
    "disabled:cursor-not-allowed disabled:opacity-50",
  ].join(" "),
});

                                                         
