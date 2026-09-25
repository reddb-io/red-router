import { tv, type VariantProps } from "tailwind-variants";

const SIZE = {
  sm: { spinner: "size-4", label: "text-xs" },
  md: { spinner: "size-5", label: "text-sm" },
  lg: { spinner: "size-8", label: "text-base" },
} as const;

export const loadingIndicator = tv({
  slots: {
    root: "inline-flex items-center justify-center gap-[var(--reddb-spatial-gap-md)] text-ink-muted",
    spinner: "motion-safe:animate-spin motion-reduce:animate-pulse text-primary-text",
    track: "fill-none stroke-current opacity-25 motion-reduce:opacity-50",
    head: "fill-none stroke-current",
    label: "leading-none",
  },
  variants: {
    size: SIZE,
    labelHidden: {
      true: { label: "sr-only" },
      false: { label: "" },
    },
  },
  defaultVariants: { size: "md", labelHidden: false },
});

export type LoadingIndicatorVariants = VariantProps<typeof loadingIndicator>;
export type LoadingIndicatorSize = NonNullable<LoadingIndicatorVariants["size"]>;
export const LOADING_INDICATOR_SIZES = Object.keys(SIZE) as readonly LoadingIndicatorSize[];
