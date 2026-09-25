// Stack's public appearance seam: one vertical flow and the complete set of
// gap roles the Density axis ships.
import { tv, type VariantProps } from "tailwind-variants";

const GAP = {
  sm: "gap-[var(--reddb-spatial-gap-sm)]",
  md: "gap-[var(--reddb-spatial-gap-md)]",
  lg: "gap-[var(--reddb-spatial-gap-lg)]",
} as const;

export const stack = tv({
  base: "flex flex-col",
  variants: { gap: GAP },
  defaultVariants: { gap: "md" },
});

export type StackVariants = VariantProps<typeof stack>;
export type StackGap = NonNullable<StackVariants["gap"]>;
export const STACK_GAPS = Object.keys(GAP) as readonly StackGap[];
