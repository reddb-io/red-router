// DateRangeField composes Fieldset and DateField; this seam only owns the
// relationship between the two fields and the group's supporting text.

import { tv, type VariantProps } from "tailwind-variants";
import { fieldset } from "./fieldset.variants";

export const dateRangeField = tv({
  slots: {
    root: fieldset().root(),
    fields: "grid gap-[var(--reddb-spatial-gap-md)] sm:grid-cols-2",
    help: "text-sm text-ink-muted",
    error: "text-sm text-foreground",
  },
});

export type DateRangeFieldVariants = VariantProps<typeof dateRangeField>;
