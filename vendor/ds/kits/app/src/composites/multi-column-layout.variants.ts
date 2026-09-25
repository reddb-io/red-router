import { tv, type VariantProps } from "tailwind-variants";

const COLUMNS = {
  two: {
    root: "md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]",
  },
  three: {
    root: [
      "md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]",
      "xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)]",
    ].join(" "),
  },
} as const;

/** Two or three responsive columns, with no assumptions about their content. */
export const multiColumnLayout = tv({
  slots: {
    root: "grid min-w-0 items-start gap-[var(--reddb-spatial-gap-lg)]",
    column: "min-w-0",
  },
  variants: { columns: COLUMNS },
  defaultVariants: { columns: "two" },
});

export type MultiColumnLayoutVariants = VariantProps<typeof multiColumnLayout>;
export type MultiColumnCount = NonNullable<MultiColumnLayoutVariants["columns"]>;
