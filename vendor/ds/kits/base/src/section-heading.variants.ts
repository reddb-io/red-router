// SectionHeading keeps outline depth independent from visual size.
import { tv, type VariantProps } from "tailwind-variants";

const SIZE = {
  sm: { title: "text-base" },
  md: { title: "text-lg" },
  lg: { title: "text-2xl" },
  display: {
    title: "text-5xl leading-none tracking-tighter sm:text-7xl lg:text-8xl",
    description: "text-lg",
  },
} as const;

const RULE = {
  true: { root: "border-b border-muted pb-[var(--reddb-spatial-inset-sm)]" },
  false: { root: "border-b border-transparent pb-0" },
} as const;

export const sectionHeading = tv({
  slots: {
    root: "flex flex-wrap items-end justify-between gap-[var(--reddb-spatial-gap-lg)]",
    text: "flex flex-col gap-[var(--reddb-spatial-gap-sm)]",
    title: "font-medium leading-tight text-foreground",
    description: "max-w-prose text-sm text-ink-muted",
    actions: "flex flex-wrap items-center gap-[var(--reddb-spatial-gap-md)]",
  },
  variants: { size: SIZE, rule: RULE },
  defaultVariants: { size: "md", rule: true },
});

export type SectionHeadingVariants = VariantProps<typeof sectionHeading>;
export type SectionHeadingSize = NonNullable<SectionHeadingVariants["size"]>;
export const SECTION_HEADING_SIZES = Object.keys(SIZE) as readonly SectionHeadingSize[];
export const SECTION_HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;
export type SectionHeadingLevel = (typeof SECTION_HEADING_LEVELS)[number];
