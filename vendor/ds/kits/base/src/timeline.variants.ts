import { tv, type VariantProps } from "tailwind-variants";

export const timeline = tv({
  slots: {
    root: "m-0 grid list-none gap-[var(--reddb-spatial-gap-md)] ps-0 text-foreground",
    item: "group relative grid min-w-0 grid-cols-[auto_1fr] gap-[var(--reddb-spatial-gap-sm)]",
    marker: [
      "mt-1 size-3 rounded-full border-2 border-foreground bg-background",
      "after:absolute after:bottom-[calc(-1*var(--reddb-spatial-gap-md))] after:start-[0.3125rem] after:top-4 after:border-s after:border-muted",
      "group-last:after:hidden",
    ].join(" "),
    content: "grid min-w-0 gap-[var(--reddb-spatial-gap-sm)]",
    time: "font-mono text-sm tabular-nums text-ink-muted",
    title: "font-medium text-foreground",
    description: "m-0 text-sm text-ink-muted",
  },
});

export type TimelineVariants = VariantProps<typeof timeline>;
