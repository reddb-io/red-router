import { tv, type VariantProps } from "tailwind-variants";

export const progress = tv({
  slots: {
    root: "w-full",
    summary: "mb-[var(--reddb-spatial-gap-sm)] flex items-center justify-between gap-[var(--reddb-spatial-gap-md)]",
    label: "text-sm text-foreground",
    value: "text-sm font-medium text-foreground",
    track:
      "h-[var(--reddb-spatial-gap-md)] w-full overflow-hidden rounded-full bg-muted",
    indicator: "h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none",
  },
  variants: {
    indeterminate: {
      true: { indicator: "w-1/3 motion-safe:animate-pulse" },
      false: { indicator: "" },
    },
  },
  defaultVariants: { indeterminate: false },
});

export type ProgressVariants = VariantProps<typeof progress>;
