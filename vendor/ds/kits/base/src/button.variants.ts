// Button's public appearance seam.
//
// Every class lives in these `tv()` contracts so a consumer can extend the
// canonical appearance without forking the element behavior. Colours resolve
// through Theme/Color Scheme roles and spatial values through Density roles;
// this module owns no appearance-axis selection or raw value.

import { tv, type VariantProps } from "tailwind-variants";

const VARIANT = {
  /** The affirmative action of a view — at most one per view. */
  primary: "bg-primary text-on-primary hover:opacity-90 focus-visible:ring-foreground",
  /** Everything else that is still an action: outlined, not filled. */
  secondary: "border-control-edge bg-transparent text-foreground hover:border-foreground focus-visible:ring-foreground",
  /** An action that should not compete for attention. */
  ghost: "bg-transparent text-ink-muted hover:text-foreground focus-visible:ring-foreground",
} as const;

const INTENT = {
  neutral: "",
  danger: "",
  success: "",
  warning: "",
  info: "",
} as const;

const SIZE = {
  sm: "h-[var(--reddb-spatial-control-height-sm)] px-[var(--reddb-spatial-inset-sm)] text-sm",
  md: "h-[var(--reddb-spatial-control-height-md)] px-[var(--reddb-spatial-inset-md)] text-sm",
  lg: "h-[var(--reddb-spatial-control-height-lg)] px-[var(--reddb-spatial-inset-lg)] text-base",
} as const;

const BLOCK = {
  /** Fills its column — a form's submit, a drawer's confirm, a mobile action. */
  true: "w-full",
  /** The default: as wide as what it says. */
  false: "",
} as const;

export const button = tv({
  base: [
    "inline-flex items-center justify-center gap-[var(--reddb-spatial-gap-md)]",
    "rounded-md border border-transparent",
    "font-medium leading-none whitespace-nowrap",
    "transition-opacity",
    "focus-visible:outline-none focus-visible:ring-2",
    "disabled:pointer-events-none disabled:opacity-50",
    "aria-disabled:pointer-events-none aria-disabled:opacity-50",
  ].join(" "),
  variants: { variant: VARIANT, intent: INTENT, size: SIZE, block: BLOCK },
  // Each intent keeps the variant's hierarchy: primary fills with the role's
  // text-grade stop, secondary outlines in the role's border, ghost carries
  // only the role's ink. A danger primary is therefore a filled destructive
  // action, distinct from its secondary and ghost forms (ADR 0009).
  compoundVariants: [
    {
      intent: "danger",
      variant: "primary",
      class: "bg-feedback-danger-foreground text-on-feedback focus-visible:ring-foreground",
    },
    {
      intent: "danger",
      variant: "secondary",
      class: "border-feedback-danger-border text-feedback-danger-foreground hover:border-feedback-danger-foreground hover:bg-feedback-danger-surface focus-visible:ring-feedback-danger-foreground",
    },
    {
      intent: "danger",
      variant: "ghost",
      class: "text-feedback-danger-foreground hover:text-feedback-danger-foreground hover:bg-feedback-danger-surface focus-visible:ring-feedback-danger-foreground",
    },
    {
      intent: "success",
      variant: "primary",
      class: "bg-feedback-success-foreground text-on-feedback focus-visible:ring-foreground",
    },
    {
      intent: "success",
      variant: "secondary",
      class: "border-feedback-success-border text-feedback-success-foreground hover:border-feedback-success-foreground hover:bg-feedback-success-surface focus-visible:ring-feedback-success-foreground",
    },
    {
      intent: "success",
      variant: "ghost",
      class: "text-feedback-success-foreground hover:text-feedback-success-foreground hover:bg-feedback-success-surface focus-visible:ring-feedback-success-foreground",
    },
    {
      intent: "warning",
      variant: "primary",
      class: "bg-feedback-warning-foreground text-on-feedback focus-visible:ring-foreground",
    },
    {
      intent: "warning",
      variant: "secondary",
      class: "border-feedback-warning-border text-feedback-warning-foreground hover:border-feedback-warning-foreground hover:bg-feedback-warning-surface focus-visible:ring-feedback-warning-foreground",
    },
    {
      intent: "warning",
      variant: "ghost",
      class: "text-feedback-warning-foreground hover:text-feedback-warning-foreground hover:bg-feedback-warning-surface focus-visible:ring-feedback-warning-foreground",
    },
    {
      intent: "info",
      variant: "primary",
      class: "bg-feedback-info-foreground text-on-feedback focus-visible:ring-foreground",
    },
    {
      intent: "info",
      variant: "secondary",
      class: "border-feedback-info-border text-feedback-info-foreground hover:border-feedback-info-foreground hover:bg-feedback-info-surface focus-visible:ring-feedback-info-foreground",
    },
    {
      intent: "info",
      variant: "ghost",
      class: "text-feedback-info-foreground hover:text-feedback-info-foreground hover:bg-feedback-info-surface focus-visible:ring-feedback-info-foreground",
    },
  ],
  defaultVariants: { variant: "primary", intent: "neutral", size: "md", block: false },
});

/** The loading indicator, inheriting the Button variant's current colour. */
export const buttonSpinner = tv({
  slots: {
    root: "shrink-0 motion-safe:animate-spin motion-reduce:animate-pulse",
    track: "fill-none stroke-current opacity-25",
    head: "fill-none stroke-current",
  },
  variants: {
    size: {
      sm: { root: "size-3.5" },
      md: { root: "size-4" },
      lg: { root: "size-5" },
    },
  },
  defaultVariants: { size: "md" },
});

export type ButtonVariants = VariantProps<typeof button>;
export type ButtonVariant = NonNullable<ButtonVariants["variant"]>;
export type ButtonIntent = NonNullable<ButtonVariants["intent"]>;
export type ButtonSize = NonNullable<ButtonVariants["size"]>;

// Enumerated from the maps so documentation and local extensions can inspect
// the same closed vocabulary the component accepts without restating it.
export const BUTTON_VARIANTS = Object.keys(VARIANT) as readonly ButtonVariant[];
export const BUTTON_INTENTS = Object.keys(INTENT) as readonly ButtonIntent[];
export const BUTTON_SIZES = Object.keys(SIZE) as readonly ButtonSize[];
