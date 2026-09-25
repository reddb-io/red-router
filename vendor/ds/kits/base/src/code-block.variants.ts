import { tv, type VariantProps } from "tailwind-variants";

export const codeBlock = tv({
  slots: {
    root: "overflow-hidden rounded-lg border border-muted bg-transparent text-foreground",
    toolbar:
      "flex items-center justify-between gap-[var(--reddb-spatial-gap-md)] border-b border-muted px-[var(--reddb-spatial-inset-md)] py-[var(--reddb-spatial-inset-sm)]",
    language: "min-w-0 truncate text-sm text-ink-muted",
    pre: "m-0 overflow-x-auto p-[var(--reddb-spatial-inset-md)]",
    code: "block whitespace-pre font-mono text-sm leading-relaxed text-foreground",
  },
});

export type CodeBlockVariants = VariantProps<typeof codeBlock>;
