"use client";

import { tv } from "tailwind-variants";
import { badge } from "@/shared/ds/badge.variants";

// The DS Badge ships neutral / primary / outline. Status badges extend it with
// the DS feedback roles, the same surface/foreground/border triple the DS Card
// and Button use for their tones, so red only ever means danger.
const statusBadge = tv({
  extend: badge,
  variants: {
    variant: {
      success: "border-[var(--reddb-color-feedback-success-border)] bg-[var(--reddb-color-feedback-success-surface)] text-[var(--reddb-color-feedback-success-foreground)]",
      warning: "border-[var(--reddb-color-feedback-warning-border)] bg-[var(--reddb-color-feedback-warning-surface)] text-[var(--reddb-color-feedback-warning-foreground)]",
      danger: "border-[var(--reddb-color-feedback-danger-border)] bg-[var(--reddb-color-feedback-danger-surface)] text-[var(--reddb-color-feedback-danger-foreground)]",
      info: "border-[var(--reddb-color-feedback-info-border)] bg-[var(--reddb-color-feedback-info-surface)] text-[var(--reddb-color-feedback-info-foreground)]",
    },
    size: {
      sm: "",
      md: "",
      lg: "px-2.5 py-1 text-sm",
    },
  },
  defaultVariants: { variant: "neutral", size: "md" },
});

// Dashboard variant names → DS names.
const VARIANTS = {
  default: "neutral",
  neutral: "neutral",
  primary: "primary",
  outline: "outline",
  success: "success",
  warning: "warning",
  error: "danger",
  danger: "danger",
  info: "info",
};

export default function Badge({
  children,
  variant = "default",
  size = "md",
  dot = false,
  icon,
  className,
}) {
  return (
    <span className={statusBadge({ variant: VARIANTS[variant] || "neutral", size, class: className })}>
      {dot && <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />}
      {icon && <span className="material-symbols-outlined text-[length:var(--reddb-spatial-icon-size-sm)] leading-none" aria-hidden="true">{icon}</span>}
      {children}
    </span>
  );
}
