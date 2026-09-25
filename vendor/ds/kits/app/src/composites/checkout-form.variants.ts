import type { HTMLInputAttributes } from "svelte/elements";
import { tv, type VariantProps } from "tailwind-variants";

/** One caller-owned checkout field rendered through canonical Field and Input. */
export interface CheckoutField {
  name: string;
  label: string;
  type?: HTMLInputAttributes["type"];
  value?: string | number;
  autocomplete?: HTMLInputAttributes["autocomplete"];
  inputmode?: HTMLInputAttributes["inputmode"];
  placeholder?: string;
  help?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
}

/** A visibly named caller-owned group of checkout fields. */
export interface CheckoutSection {
  legend: string;
  fields: readonly CheckoutField[];
  disabled?: boolean;
}

/** Token-only arrangement around canonical Base form contracts. */
export const checkoutForm = tv({
  slots: {
    root: "flex w-full min-w-0 flex-col gap-[var(--reddb-spatial-gap-lg)]",
    error: "m-0 font-medium text-foreground",
    section: "flex min-w-0 flex-col gap-[var(--reddb-spatial-gap-md)]",
    actions: "flex flex-wrap items-center justify-end gap-[var(--reddb-spatial-gap-md)]",
  },
});

export type CheckoutFormVariants = VariantProps<typeof checkoutForm>;
