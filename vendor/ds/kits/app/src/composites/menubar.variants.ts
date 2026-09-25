import { popover } from "@reddb-io/design-system/base";
import { tv, type VariantProps } from "tailwind-variants";

export const menubar = tv({
  slots: {
    root: "flex items-center gap-[var(--reddb-spatial-gap-sm)] data-[command-menubar]:items-center",
    content: popover({ class: "min-w-48 p-[var(--reddb-spatial-inset-sm)]" }),
    group: "flex flex-col",
    heading: "px-[var(--reddb-spatial-inset-sm)] py-1 text-xs font-medium text-ink-muted",
    separator: "my-1 h-px bg-muted",
    item: [
      "flex w-full select-none items-center rounded-md text-start text-foreground outline-none",
      "data-[highlighted]:bg-foreground/10 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
    ].join(" "),
    icon: "me-[var(--reddb-spatial-gap-sm)] inline-flex shrink-0",
  },
  variants: {
    size: {
      sm: {
        item: "h-[var(--reddb-spatial-control-height-sm)] px-[var(--reddb-spatial-inset-sm)] text-sm",
        icon: "size-[var(--reddb-spatial-icon-size-sm)]",
      },
      md: {
        item: "h-[var(--reddb-spatial-control-height-md)] px-[var(--reddb-spatial-inset-md)] text-sm",
        icon: "size-[var(--reddb-spatial-icon-size-md)]",
      },
      lg: {
        item: "h-[var(--reddb-spatial-control-height-lg)] px-[var(--reddb-spatial-inset-lg)] text-base",
        icon: "size-[var(--reddb-spatial-icon-size-lg)]",
      },
    },
  },
  defaultVariants: { size: "md" },
});

export type MenubarVariants = VariantProps<typeof menubar>;
export type MenubarSize = NonNullable<MenubarVariants["size"]>;
