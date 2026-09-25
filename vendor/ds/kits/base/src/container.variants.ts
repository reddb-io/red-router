// Container's public appearance seam. Its width is structural; only the
// inline inset belongs to Density, so that role remains live in every scope.
import { tv, type VariantProps } from "tailwind-variants";

export const container = tv({
  base: "mx-auto box-border w-full max-w-7xl px-[var(--reddb-spatial-inset-md)]",
});

export type ContainerVariants = VariantProps<typeof container>;
