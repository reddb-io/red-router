import { card } from "@reddb-io/design-system/base";
import { tv, type VariantProps } from "tailwind-variants";

const ROOT = card({ variant: "plain", padding: "none" }).root({
  class: "group h-full min-w-0 overflow-hidden",
});

/** Token-only presentation around canonical Card, AspectRatio, and Link contracts. */
export const categoryPreview = tv({
  slots: {
    root: ROOT,
    media: "overflow-hidden rounded-lg bg-muted/10",
    content: "flex min-w-0 flex-col gap-[var(--reddb-spatial-gap-sm)] pt-[var(--reddb-spatial-inset-sm)]",
    name: "text-base font-semibold leading-tight text-foreground",
    description: "text-sm text-ink-muted",
  },
});

export type CategoryPreviewVariants = VariantProps<typeof categoryPreview>;
