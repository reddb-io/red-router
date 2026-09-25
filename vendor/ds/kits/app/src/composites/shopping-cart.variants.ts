import { tv, type VariantProps } from "tailwind-variants";
import type { Snippet } from "svelte";

/** Caller-owned product data used by one editable cart row. */
export interface ShoppingCartItem {
  id: string;
  name: string;
  description?: string;
  price: string;
  quantity: number;
  quantityName?: string;
  disabled?: boolean;
  /** Caller-owned product media with its own accessible alternative. */
  media?: Snippet;
  /** Caller-owned detail rendering for configurations or other product metadata. */
  details?: Snippet;
  /** Caller-owned per-item actions rendered after the canonical quantity control. */
  actions?: Snippet;
}

/** Token-only arrangement around canonical Base form and list contracts. */
export const shoppingCart = tv({
  slots: {
    root: "flex w-full min-w-0 flex-col gap-[var(--reddb-spatial-gap-lg)]",
    heading: "pb-0",
    list: "m-0 list-none p-0",
    item: "grid min-w-0 gap-[var(--reddb-spatial-gap-md)] sm:grid-cols-[minmax(0,1fr)_auto]",
    details: "grid min-w-0 gap-[var(--reddb-spatial-gap-md)]",
    media: "min-w-0 overflow-hidden rounded-md bg-muted/10",
    identity: "min-w-0",
    name: "m-0 font-medium text-foreground",
    description: "m-0 text-ink-muted",
    price: "m-0 text-foreground",
    controls: "flex flex-wrap items-end gap-[var(--reddb-spatial-gap-md)]",
    itemActions: "flex flex-wrap items-center gap-[var(--reddb-spatial-gap-sm)]",
    quantity: "w-24",
    empty: "min-w-0",
    total: "flex items-center justify-between gap-[var(--reddb-spatial-gap-md)] font-medium",
    actions: "flex flex-wrap items-center justify-end gap-[var(--reddb-spatial-gap-md)]",
  },
});

export type ShoppingCartVariants = VariantProps<typeof shoppingCart>;
