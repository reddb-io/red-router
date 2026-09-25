// ToggleGroup's public option contract and token-only group appearance seam.
import { tv, type VariantProps } from "tailwind-variants";

export interface ToggleGroupOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export const toggleGroup = tv({
  slots: {
    root: "min-w-0",
    list: [
      "inline-flex flex-nowrap items-center gap-0 overflow-hidden rounded-md",
      "border border-control-edge",
      "divide-x divide-control-edge",
      "p-[var(--reddb-spatial-inset-sm)]",
    ].join(" "),
    // Every option carries the 2px bottom edge the pressed indicator paints,
    // transparent until pressed, so choosing an option moves nothing.
    option: [
      "h-[var(--reddb-spatial-control-height-md)] rounded-none border-0 border-b-2 border-transparent",
      "px-[var(--reddb-spatial-inset-sm)] leading-normal",
    ].join(" "),
  },
});

export type ToggleGroupVariants = VariantProps<typeof toggleGroup>;
