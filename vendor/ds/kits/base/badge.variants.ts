import { tv, type VariantProps } from "tailwind-variants";

const VARIANT = {
  /** The default: present without claiming attention. */
  neutral: "border-transparent bg-muted text-foreground",
  /** Reserved for the one status that matters on a screen. */
  primary: "border-transparent bg-primary text-on-primary",
  /** The quietest form — the surface shows through. */
  outline: "border-muted bg-transparent text-foreground",
} as const;

export const badge = tv({
  base: "inline-flex items-center gap-[var(--reddb-spatial-gap-sm)] rounded-md border px-2 py-0.5 text-xs font-medium leading-none whitespace-nowrap",
  variants: { variant: VARIANT },
  defaultVariants: { variant: "neutral" },
});

export type BadgeVariants = VariantProps<typeof badge>;
export type BadgeVariant = NonNullable<BadgeVariants["variant"]>;

export const BADGE_VARIANTS = Object.keys(VARIANT) as readonly BadgeVariant[];
