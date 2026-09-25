// RadioGroup's public option shape and token-only appearance seam.

import { tv, type VariantProps } from "tailwind-variants";

export interface RadioGroupOption {
  /** Native submitted value for this choice. */
  value: string;
  /** Caller-owned visible label. */
  label: string;
  /** Removes only this option from interaction and submission. */
  disabled?: boolean;
}

export const radioGroup = tv({
  slots: {
    root: "grid min-w-0 gap-[var(--reddb-spatial-gap-md)] border-0 p-0",
    list: "grid gap-[var(--reddb-spatial-gap-sm)]",
    option: "flex cursor-pointer items-center gap-[var(--reddb-spatial-gap-sm)] text-sm text-foreground",
    control: [
      "h-[var(--reddb-spatial-control-height-sm)] w-[var(--reddb-spatial-control-height-sm)] shrink-0",
      "cursor-pointer border border-control-edge bg-background accent-primary text-primary-text",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
      "disabled:cursor-not-allowed disabled:opacity-50",
    ].join(" "),
  },
});

export type RadioGroupVariants = VariantProps<typeof radioGroup>;
