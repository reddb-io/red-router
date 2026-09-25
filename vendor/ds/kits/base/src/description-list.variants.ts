import type { Snippet } from "svelte";
import { tv, type VariantProps } from "tailwind-variants";

const GAP = {
  sm: "gap-[var(--reddb-spatial-gap-sm)]",
  md: "gap-[var(--reddb-spatial-gap-md)]",
  lg: "gap-[var(--reddb-spatial-gap-lg)]",
} as const;

export const descriptionList = tv({
  slots: {
    root: "grid",
    item: "grid sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]",
    term: "font-medium text-foreground",
    detail: "m-0 text-ink-muted",
  },
  variants: {
    gap: {
      sm: { root: GAP.sm, item: GAP.sm },
      md: { root: GAP.md, item: GAP.md },
      lg: { root: GAP.lg, item: GAP.lg },
    },
  },
  defaultVariants: { gap: "md" },
});

export type DescriptionListVariants = VariantProps<typeof descriptionList>;
export type DescriptionListGap = NonNullable<DescriptionListVariants["gap"]>;
export const DESCRIPTION_LIST_GAPS = Object.keys(GAP) as readonly DescriptionListGap[];

export type DescriptionListContent = string | Snippet;

export interface DescriptionListItem {
  term: DescriptionListContent;
  detail: DescriptionListContent;
}
