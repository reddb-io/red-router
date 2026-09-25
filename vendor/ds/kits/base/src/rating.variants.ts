// Rating's option shape and token-only appearance seam.
import { tv, type VariantProps } from "tailwind-variants";

export const rating = tv({
  slots: {
    root: "min-w-0",
    list: "flex flex-wrap items-center gap-[var(--reddb-spatial-gap-sm)]",
    option: "relative cursor-pointer text-foreground disabled:cursor-not-allowed",
    control: "peer sr-only",
    mark: [
      "inline-flex h-[var(--reddb-spatial-control-height-sm)] min-w-[var(--reddb-spatial-control-height-sm)]",
      "items-center justify-center text-foreground",
      "peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-primary",
      "peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
    ].join(" "),
    output: "text-sm tabular-nums text-ink-muted",
  },
});

export type RatingVariants = VariantProps<typeof rating>;
