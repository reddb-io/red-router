import { tv, type VariantProps } from "tailwind-variants";

export const productQuickview = tv({
  slots: {
    root: "contents",
    dialog: "text-foreground",
    content: "isolate grid min-w-0 gap-[var(--reddb-spatial-gap-lg)] md:grid-cols-2",
    media: "min-w-0 overflow-hidden rounded-lg bg-muted/10",
    body: "grid min-w-0 content-start gap-[var(--reddb-spatial-gap-md)]",
  },
});

export type ProductQuickviewVariants = VariantProps<typeof productQuickview>;
