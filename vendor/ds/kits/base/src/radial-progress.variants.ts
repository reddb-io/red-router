import { tv, type VariantProps } from "tailwind-variants";

const SIZE = {
  sm: {
    root: "size-[calc(var(--reddb-spatial-control-height-sm)*2)]",
    value: "text-xs",
  },
  md: {
    root: "size-[calc(var(--reddb-spatial-control-height-md)*2)]",
    value: "text-sm",
  },
  lg: {
    root: "size-[calc(var(--reddb-spatial-control-height-lg)*2.4)]",
    value: "text-base",
  },
} as const;

export const radialProgress = tv({
  slots: {
    root: "relative inline-grid shrink-0 place-items-center text-foreground",
    svg: "size-full -rotate-90",
    track: "fill-none stroke-muted",
    indicator:
      "fill-none stroke-primary transition-[stroke-dashoffset] motion-reduce:transition-none",
    value: "absolute inset-0 flex items-center justify-center font-medium tabular-nums",
  },
  variants: {
    size: SIZE,
    indeterminate: {
      true: { svg: "motion-safe:animate-spin", value: "sr-only" },
      false: { svg: "", value: "" },
    },
  },
  defaultVariants: { size: "md", indeterminate: false },
});

export type RadialProgressVariants = VariantProps<typeof radialProgress>;
export type RadialProgressSize = NonNullable<RadialProgressVariants["size"]>;
export const RADIAL_PROGRESS_SIZES = Object.keys(SIZE) as readonly RadialProgressSize[];
