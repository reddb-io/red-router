// Form's public scaffold seam: flow only, with local arrangement still extensible.
import { tv, type VariantProps } from "tailwind-variants";

export const form = tv({
  base: "grid gap-[var(--reddb-spatial-gap-md)]",
});

export type FormVariants = VariantProps<typeof form>;
