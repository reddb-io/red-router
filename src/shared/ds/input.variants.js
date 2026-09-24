// GENERATED from vendor/ds/kits/base/input.variants.ts by scripts/sync-ds-variants.mjs — do not edit.
// Input's public appearance seam. Input itself owns only the native element
// and forwarding behavior; this function is where a consumer composes or
// extends the canonical appearance without copying that behavior.

import { tv,                   } from "tailwind-variants";

export const input = tv({
  base: [
    "flex w-full h-[var(--reddb-spatial-control-height-md)]",
    "rounded-md border border-control-edge bg-background",
    "px-[var(--reddb-spatial-inset-md)] text-sm text-foreground",
    "placeholder:text-ink-muted",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
    "aria-invalid:border-feedback-danger-border",
    "disabled:cursor-not-allowed disabled:opacity-50",
  ].join(" "),
});

                                                       
