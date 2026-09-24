// Button's public appearance seam.
//
// Every class lives in these `tv()` contracts so a consumer can extend the
// canonical appearance without forking the element behavior. Colours resolve
// through Theme/Color Scheme roles and spatial values through Density roles;
// this module owns no appearance-axis selection or raw value.

import { tv, type VariantProps } from "tailwind-variants";

const VARIANT = {
  /** The affirmative action of a view — at most one per view. */
  primary: "bg-primary text-on-primary hover:opacity-90 focus-visible:ring-on-primary",
  /** Everything else that is still an action: outlined, not filled. */
  secondary: "border-muted bg-transparent text-foreground hover:border-foreground focus-visible:ring-foreground",
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
  compoundVariants: [
    {
      intent: "danger",
      variant: ["primary", "secondary", "ghost"],
      class: "bg-[var(--reddb-color-feedback-danger-surface)] text-[var(--reddb-color-feedback-danger-foreground)] focus-visible:ring-[var(--reddb-color-feedback-danger-foreground)]",
    },
    {
      intent: "danger",
      variant: "primary",
      class: "border-[var(--reddb-color-feedback-danger-border)]",
    },
    {
      intent: "danger",
      variant: "secondary",
      class: "border-[var(--reddb-color-feedback-danger-border)] hover:bg-[var(--reddb-color-feedback-danger-surface)]",
    },
    {
      intent: "danger",
      variant: "ghost",
      class: "hover:bg-[var(--reddb-color-feedback-danger-surface)]",
    },
    {
      intent: "success",
      variant: ["primary", "secondary", "ghost"],
      class: "bg-[var(--reddb-color-feedback-success-surface)] text-[var(--reddb-color-feedback-success-foreground)] focus-visible:ring-[var(--reddb-color-feedback-success-foreground)]",
    },
    {
      intent: "success",
      variant: "primary",
      class: "border-[var(--reddb-color-feedback-success-border)]",
    },
    {
      intent: "success",
      variant: "secondary",
      class: "border-[var(--reddb-color-feedback-success-border)] hover:bg-[var(--reddb-color-feedback-success-surface)]",
    },
    {
      intent: "success",
      variant: "ghost",
      class: "hover:bg-[var(--reddb-color-feedback-success-surface)]",
    },
    {
      intent: "warning",
      variant: ["primary", "secondary", "ghost"],
      class: "bg-[var(--reddb-color-feedback-warning-surface)] text-[var(--reddb-color-feedback-warning-foreground)] focus-visible:ring-[var(--reddb-color-feedback-warning-foreground)]",
    },
    {
      intent: "warning",
      variant: "primary",
      class: "border-[var(--reddb-color-feedback-warning-border)]",
    },
    {
      intent: "warning",
      variant: "secondary",
      class: "border-[var(--reddb-color-feedback-warning-border)] hover:bg-[var(--reddb-color-feedback-warning-surface)]",
    },
    {
      intent: "warning",
      variant: "ghost",
      class: "hover:bg-[var(--reddb-color-feedback-warning-surface)]",
    },
    {
      intent: "info",
      variant: ["primary", "secondary", "ghost"],
      class: "bg-[var(--reddb-color-muted)] text-[var(--reddb-color-foreground)] focus-visible:ring-[var(--reddb-color-foreground)]",
    },
    {
      intent: "info",
      variant: "primary",
      class: "border-[var(--reddb-color-foreground)]",
    },
    {
      intent: "info",
      variant: "secondary",
      class: "border-[var(--reddb-color-foreground)] hover:bg-[var(--reddb-color-muted)]",
    },
    {
      intent: "info",
      variant: "ghost",
      class: "hover:bg-[var(--reddb-color-muted)]",
    },
  ],
  defaultVariants: { variant: "primary", intent: "neutral", size: "md", block: false },
});

/** The loading indicator, inheriting the Button variant's current colour. */
export const buttonSpinner = tv({
  slots: {
    root: "shrink-0 animate-spin",
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
