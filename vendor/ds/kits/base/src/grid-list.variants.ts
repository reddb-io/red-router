import { tv, type VariantProps } from "tailwind-variants";

export const GRID_LIST_COLUMNS = [1, 2, 3, 4] as const;
export type GridListColumn = (typeof GRID_LIST_COLUMNS)[number];

export const gridList = tv({
  base: "grid w-full",
  variants: {
    columns: {
      1: "grid-cols-1",
      2: "grid-cols-1 sm:grid-cols-2",
      3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
      4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
    },
  },
  defaultVariants: { columns: 1 },
});

export type GridListVariants = VariantProps<typeof gridList>;
