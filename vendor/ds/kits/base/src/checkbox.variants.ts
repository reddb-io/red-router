// Checkbox's optional appearance seam. Native checked, required, disabled,
// focus, and form behavior stay on the input; this function only supplies the
// token-backed skin a consumer may compose onto another native checkbox.

import { tv, type VariantProps } from "tailwind-variants";

export const checkbox = tv({
  base: [
    "h-[var(--reddb-spatial-control-height-sm)] w-[var(--reddb-spatial-control-height-sm)] shrink-0",
    "cursor-pointer rounded-sm border border-control-edge bg-background accent-primary text-primary-text",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
    "aria-invalid:border-feedback-danger-border disabled:cursor-not-allowed disabled:opacity-50",
  ].join(" "),
});

export type CheckboxVariants = VariantProps<typeof checkbox>;
