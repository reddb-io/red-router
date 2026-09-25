import { tv, type VariantProps } from "tailwind-variants";

export const productOverview = tv({
  slots: {
    root: "grid min-w-0 items-start gap-[var(--reddb-spatial-gap-lg)] md:grid-cols-2",
    media: "min-w-0 overflow-hidden rounded-lg bg-muted/10",
    content: "min-w-0",
    heading: "items-start pb-0",
    price: "text-lg font-semibold text-foreground",
    body: "flex flex-col gap-[var(--reddb-spatial-gap-md)] text-foreground",
    actions: "flex flex-wrap items-center gap-[var(--reddb-spatial-gap-md)]",
  },
});

export type ProductOverviewVariants = VariantProps<typeof productOverview>;
