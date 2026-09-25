// Fieldset's appearance preserves the native group while naming only DS roles.
import { tv, type VariantProps } from "tailwind-variants";

export const fieldset = tv({
  slots: {
    root: "grid min-w-0 gap-[var(--reddb-spatial-gap-md)] border-0 p-0",
    legend: "mb-[var(--reddb-spatial-gap-sm)] text-sm font-medium text-foreground",
  },
});

export type FieldsetVariants = VariantProps<typeof fieldset>;
