import { tv, type VariantProps } from "tailwind-variants";
import { dialog } from "./dialog.variants";

export const DRAWER_SIDES = ["top", "right", "bottom", "left"] as const;
export type DrawerSide = (typeof DRAWER_SIDES)[number];

const SIDE: Record<DrawerSide, string> = {
  top: "inset-x-0 top-0 w-full max-w-none",
  right: "inset-y-0 right-0 h-full w-full max-w-md",
  bottom: "inset-x-0 bottom-0 w-full max-w-none",
  left: "inset-y-0 left-0 h-full w-full max-w-md",
};

/** Dialog appearance specialized into an edge-anchored surface. */
export const drawer = tv({
  base: [
    dialog(),
    "fixed m-0 max-h-none overflow-y-auto rounded-none",
    "motion-safe:transition-transform",
  ].join(" "),
  variants: { side: SIDE },
  defaultVariants: { side: "right" },
});

export type DrawerVariants = VariantProps<typeof drawer>;
