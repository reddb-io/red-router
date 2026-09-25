import { mediaObject } from "@reddb-io/design-system/base";
import { tv, type VariantProps } from "tailwind-variants";

const ROOT = mediaObject({ gap: "lg" }).root({
  class: "w-full flex-col md:flex-row",
});

export const productFeature = tv({
  slots: {
    root: ROOT,
    media: "min-w-0 flex-1 overflow-hidden rounded-lg bg-muted/10",
    content: "min-w-0 flex-1",
    heading: "items-start pb-0",
    body: "flex flex-col gap-[var(--reddb-spatial-gap-md)] text-foreground",
    actions: "flex flex-wrap items-center gap-[var(--reddb-spatial-gap-md)]",
  },
  variants: {
    mediaSide: {
      start: { root: "md:flex-row" },
      end: { root: "flex-col-reverse md:flex-row-reverse" },
    },
  },
  defaultVariants: { mediaSide: "start" },
});

export type ProductFeatureVariants = VariantProps<typeof productFeature>;
export type ProductFeatureMediaSide = NonNullable<ProductFeatureVariants["mediaSide"]>;
export const PRODUCT_FEATURE_MEDIA_SIDES = ["start", "end"] as const;
